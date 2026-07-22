/**
 * Extension host entry — Increment 2: live transport.
 *
 * `viewer.open` opens a webview panel and spawns the Python producer as a
 * long-lived child process. The host is the broker between the two:
 *
 *   webview ⇄ (postMessage) ⇄ host ⇄ (length-framed stdio) ⇄ producer
 *
 * The webview sends small JSON requests ({type:"toProducer", request}); the
 * host writes them framed to the producer's stdin, reads framed responses off
 * stdout, and forwards each payload to the webview as a Uint8Array
 * ({type:"fromProducer", payload} — VS Code passes typed arrays through
 * postMessage on the binary path, not as JSON). Closing the panel terminates
 * the producer.
 *
 * Optional command args pick the dataset size:
 *   vscode.commands.executeCommand("viewer.open", { nPoints: 250000, nFrames: 2500 })
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { buildWebviewCsp } from "./webviewcsp.ts";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProducerBroker } from "./broker.ts";
import { parseModFile, resolveParameters, serializeMod, type AnalysisMod, type Mod } from "../webview/recipes.ts";
import { replacementNote, saveModFile, type ModWriteResult } from "./modfile.ts";
import { parseClaudeCommand, type ClaudeCommand } from "../webview/claudemodel.ts";
import { createClaudeStub } from "../webview/claudestub.ts";
import { DEFAULT_COLOR, DEFAULT_OPACITY, DEFAULT_SIZE } from "../webview/representation.ts";
import { createClaudeBackend, type ClaudeBackend } from "./claudebackend.ts";
import { buildTargetExamples, gatherLiveState, type SceneContext } from "./claudetools.ts";
import { relaysTerminalMessageToViewer, resolveModDeletion } from "./hostmessages.ts";
import { clearApiKey, NO_KEY_HINT, promptAndStoreApiKey, resolveApiKey } from "./claudeauth.ts";
import { createPlotHost } from "../webview/plothost.ts";
import { HUD_BODY, HUD_CSS } from "../webview/hud.ts";
import { PLOT_BODY, PLOT_CSS } from "../webview/plothud.ts";
import { TERMINAL_BODY, TERMINAL_CSS } from "../webview/terminalhud.ts";

const DEFAULT_N_POINTS = 20_000;
const DEFAULT_N_FRAMES = 600;

/** A backend at the conversation panel's boundary — the real SDK backend or the
 * scripted stub; both speak the frozen contract. */
type PanelBackend = {
  handle(cmd: ClaudeCommand): void;
  dispose(): void;
  setApiKey?(key: string | null): void;
};

/** Live assistant backends across all open panels, so the set/clear-key
 * commands can re-drive their auth-status without reaching into a closure. */
const liveBackends = new Set<PanelBackend>();

/** A current Sonnet model, overridable via the `molaro.assistant.model` setting. */
const DEFAULT_MODEL = "claude-sonnet-5";

function assistantConfig(): { useStub: boolean; model: string } {
  const cfg = vscode.workspace.getConfiguration("molaro");
  return {
    useStub: cfg.get<boolean>("assistant.useStub", false),
    model: cfg.get<string>("assistant.model", DEFAULT_MODEL) || DEFAULT_MODEL,
  };
}

/** The minimal shape of the producer header the host peeks off the stream to
 * answer get_context (system shape) — a read of a message already flowing to
 * the viewer, never an injected request. */
interface HeaderPeek {
  name: string;
  n_points: number;
  n_frames: number;
  categories: string[];
  groups: Record<string, string>;
  subgroups: Record<string, string>;
  points: { category: number[]; type: string[] };
  provenance?: string[];
}

interface OpenArgs {
  // Synthetic (default) source:
  nPoints?: number;
  nFrames?: number;
  seed?: number;
  // Real mdtraj source (Increment 3): a benchmark system id OR an explicit
  // topology (+ optional trajectory) path. `pythonPath` must point at an
  // mdtraj-capable interpreter (e.g. the mdbench conda env) for real datasets.
  system?: string;
  topology?: string;
  trajectory?: string;
  ligandResidues?: string[];
  pythonPath?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const producerLog = vscode.window.createOutputChannel("Point Viewer Producer");
  context.subscriptions.push(producerLog);

  // viewer.open — synthetic (default) or a benchmark system / explicit topology.
  context.subscriptions.push(
    vscode.commands.registerCommand("viewer.open", (args?: OpenArgs) => {
      const isReal = Boolean(args?.system || args?.topology);
      const nPoints = args?.nPoints ?? DEFAULT_N_POINTS;
      const nFrames = args?.nFrames ?? DEFAULT_N_FRAMES;
      const seed = args?.seed ?? 7;

      let producerArgs: string[];
      let title: string;
      if (args?.system) {
        producerArgs = ["--system", args.system];
        title = `Point Viewer (${args.system})`;
      } else if (args?.topology) {
        producerArgs = ["--dataset", args.topology];
        if (args.trajectory) producerArgs.push("--trajectory", args.trajectory);
        for (const lig of args.ligandResidues ?? []) producerArgs.push("--ligand-residue", lig);
        title = `Point Viewer (${args.topology.split("/").pop()})`;
      } else {
        producerArgs = ["--n-points", String(nPoints), "--n-frames", String(nFrames), "--seed", String(seed)];
        title = `Point Viewer (N=${nPoints})`;
      }
      openPanel(context, producerLog, {
        producerArgs,
        title,
        pythonPath: args?.pythonPath ?? (isReal ? realPythonPath() : undefined),
      });
    }),
  );

  // viewer.openTerminal — the command terminal for the most recently active
  // viewer panel (the panel's own "Terminal" button is the primary entry).
  context.subscriptions.push(
    vscode.commands.registerCommand("viewer.openTerminal", () => {
      if (!lastViewerSession) {
        void vscode.window.showInformationMessage("Open a Point Viewer panel first.");
        return;
      }
      lastViewerSession.openTerminal();
    }),
  );

  // Assistant API-key management — VS Code native, never the webview. Setting or
  // clearing the key re-drives auth-status on every live backend immediately.
  context.subscriptions.push(
    vscode.commands.registerCommand("viewer.setApiKey", async () => {
      const key = await promptAndStoreApiKey(context);
      if (key === null) return; // dismissed
      for (const b of liveBackends) b.setApiKey?.(key);
      void vscode.window.showInformationMessage("Molaro: Anthropic API key stored.");
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("viewer.clearApiKey", async () => {
      await clearApiKey(context);
      const fallback = await resolveApiKey(context); // an env var may still supply one
      for (const b of liveBackends) b.setApiKey?.(fallback);
      void vscode.window.showInformationMessage(
        fallback
          ? "Molaro: stored key cleared (ANTHROPIC_API_KEY still in effect)."
          : "Molaro: Anthropic API key cleared.",
      );
    }),
  );

  // viewer.openFile — open the viewer directly on a data file (Increment 4.6),
  // invokable from the Explorer context menu. The data-source layer resolves a
  // companion topology for trajectory files; structure files open standalone.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "viewer.openFile",
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const target = uri ?? uris?.[0] ?? (await pickFile());
        if (!target) return;
        openPanel(context, producerLog, {
          producerArgs: ["--open", target.fsPath],
          title: `Point Viewer (${target.path.split("/").pop()})`,
          pythonPath: realPythonPath(),
        });
      },
    ),
  );
}

/** The workspace mod directory (persistence lives here; nothing else does). */
function modsDir(): string | null {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return ws ? join(ws, ".molaro", "mods") : null;
}

/** Startup scan of `.molaro/mods/*.py` — parse each with the shared pure
 * parser; a malformed file is SKIPPED with a reported warning (one bad mod
 * must never break startup or the registry). Loaded files get origin
 * "workspace" (assigned here, never read from the file). */
function loadWorkspaceMods(
  log: vscode.OutputChannel,
  modPaths?: Map<string, string>,
): AnalysisMod[] {
  const dir = modsDir();
  if (!dir) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
  } catch {
    return []; // no .molaro/mods — nothing to load
  }
  modPaths?.clear();
  const mods: AnalysisMod[] = [];
  for (const file of files) {
    try {
      const parsed = parseModFile(readFileSync(join(dir, file), "utf-8"), "workspace");
      if (parsed.ok) {
        mods.push(parsed.mod);
        // rm's name → file map: deletion uses ONLY paths recorded by this
        // scan (the mod's name comes from the header, not the filename),
        // which is what confines rm to .molaro/mods forever
        modPaths?.set(parsed.mod.name, join(dir, file));
      } else log.appendLine(`[mods] skipped ${file}: ${parsed.error}`);
    } catch (err) {
      log.appendLine(`[mods] skipped ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (mods.length > 0) log.appendLine(`[mods] loaded ${mods.length} workspace mod(s) from ${dir}`);
  return mods;
}

/** Format assistant-passed parameters as the invocation string's `?key=value`
 * block. A value holding a `?` (a false segment boundary) or with significant
 * leading/trailing space is double-quoted so the invocation parser's quote-aware
 * split keeps it intact; the parser unwraps it. "" when there are no parameters. */
function formatModParams(parameters?: Record<string, unknown>): string {
  if (!parameters) return "";
  return Object.entries(parameters)
    .map(([k, v]) => {
      let s = typeof v === "string" ? v : String(v);
      if (s.includes("?") || s !== s.trim()) s = `"${s.replace(/"/g, "")}"`;
      return `?${k}=${s}`;
    })
    .join(" ");
}

/** Render a 0..1 RGB triple as `#rrggbb` for display (the base color the model
 * is told about — representation.ts holds the numeric source of truth). */
function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** The save path a later authoring step writes through: serialize a mod to
 * `.molaro/mods/<name>.py`. Analysis mods only (serializeMod refuses R
 * mods — they are code, not files). The write itself lives in src/modfile.ts,
 * which is vscode-free and therefore testable — it preserves any prior file
 * rather than clobbering it, and reports what it displaced. */
export function saveWorkspaceMod(mod: Mod): ModWriteResult {
  const dir = modsDir();
  if (!dir) throw new Error("no workspace folder — nowhere to save mods");
  return saveModFile(dir, mod.name, serializeMod(mod));
}

async function pickFile(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Open in Point Viewer",
    title: "Open a structure or trajectory file",
  });
  return picked?.[0];
}

interface PanelOpts {
  producerArgs: string[];
  title: string;
  pythonPath?: string;
}

/** The viewer panel the `viewer.openTerminal` command targets — the most
 * recently created or focused one. */
interface ViewerSession {
  openTerminal(): void;
}
let lastViewerSession: ViewerSession | null = null;

function openPanel(
  context: vscode.ExtensionContext,
  producerLog: vscode.OutputChannel,
  opts: PanelOpts,
): void {
  const panel = vscode.window.createWebviewPanel(
    "viewer",
    opts.title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // Keep the viewer's context alive while its tab is backgrounded.
      // Without this, VS Code DESTROYS the webview on hide and reloads the
      // page from scratch on re-show (confirmed by CDP probe: the webview
      // target vanishes on hide; a fresh target with none of the old JS
      // state appears on return, and the page re-requests the stream over
      // the surviving broker). That wiped everything not re-derivable —
      // the nine representation buffers (the only state that exists
      // nowhere but the buffers), committed selections, hides, the undo
      // stack, camera pose, and the playhead. Retention keeps the live
      // context, so nothing is "restored" — and therefore the undo stack
      // is untouched by tab round-trips, by construction. Trade-off: a
      // hidden viewer holds its DOM/JS/GL memory (same decision as the
      // terminal panel below, at a higher cost accepted knowingly).
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
    },
  );

  // The loaded system's header, PEEKED off the producer stream (the header is
  // the first JSON response the viewer requests at boot) — a read of a message
  // already flowing to the viewer, so get_context needs no injected request and
  // the producer FIFO is undisturbed. Cached once.
  let cachedHeader: HeaderPeek | null = null;
  const peekHeader = (payload: Uint8Array): void => {
    if (cachedHeader || payload.length === 0 || payload[0] !== 0x7b /* { */) return;
    try {
      const obj = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      if (typeof obj.n_points === "number" && Array.isArray(obj.categories)) {
        cachedHeader = obj as unknown as HeaderPeek;
      }
    } catch { /* not the header (a frame chunk or a non-JSON payload) */ }
  };

  const broker = new ProducerBroker(
    {
      pythonPath: opts.pythonPath,
      serveScript: vscode.Uri.joinPath(context.extensionUri, "producer", "serve.py").fsPath,
      producerArgs: opts.producerArgs,
    },
    {
      onMessage: (payload) => {
        peekHeader(payload);
        void panel.webview.postMessage({ type: "fromProducer", payload });
      },
      onExit: (reason) => {
        void panel.webview.postMessage({ type: "producerExit", message: reason });
        void vscode.window.showErrorMessage(`Point Viewer producer: ${reason}`);
      },
      onLog: (line) => producerLog.appendLine(line),
    },
  );

  // Command terminal — a sibling webview panel per viewer. The host is a dumb
  // relay: terminal → viewer {type:"command", id, text}; viewer → terminal
  // {type:"commandResult", id, status, message}. All resolution/execution is
  // viewer-side (webview/commands.ts).
  let terminal: vscode.WebviewPanel | null = null;
  let claudeBackend: PanelBackend | null = null;
  /** rm's name → file map, populated ONLY by the mod scan (and save). */
  const modPaths = new Map<string, string>();

  // --- assistant → viewer command injection -------------------------------
  // The assistant's run_mod/run_command tools drive the EXISTING command relay:
  // the host posts {type:"command", id, text} to the viewer (the same message
  // the terminal sends) on a private high id range, captures the id-correlated
  // ack, and — for a mod invocation, whose real outcome (including a failure
  // traceback) arrives as an async id:-1 follow-up — the following async line.
  // No viewer change; the viewer resolves, runs, and binds exactly as it does
  // for a typed command.
  let assistantCmdSeq = 1_000_000;
  const pendingAsstAck = new Map<number, (r: { ok: boolean; message: string }) => void>();
  let pendingModOutcome: ((r: { ok: boolean; message: string }) => void) | null = null;
  const MOD_ACK = /^running .+ points/; // "running <mod> on <N> points…"

  const runViewerCommand = (text: string): Promise<{ ok: boolean; message: string }> =>
    new Promise((resolve) => {
      const id = assistantCmdSeq++;
      const timer = setTimeout(() => {
        pendingAsstAck.delete(id);
        resolve({ ok: false, message: "viewer command timed out" });
      }, 60_000);
      pendingAsstAck.set(id, (r) => { clearTimeout(timer); resolve(r); });
      void panel.webview.postMessage({ type: "command", id, text });
    });

  const assembleContext = async (): Promise<SceneContext | null> => {
    const h = cachedHeader;
    if (!h) return null;
    const ls = await runViewerCommand("ls").catch(() => ({ ok: true, message: "(unavailable)" }));
    // LIVE representation state via the SAME viewer round-trip — NEVER the
    // cached header, so a mid-session declared channel / new binding / drawn
    // shape appears in this get_context, not the next reload.
    const liveState = await gatherLiveState(runViewerCommand);
    const mods = loadWorkspaceMods(producerLog, modPaths).map((m) => ({
      name: m.name, produces: m.produces, axis: m.axis, description: m.description,
      ...(m.channel ? { channel: m.channel } : {}),
      ...(m.requiresChannel ? { requiresChannel: m.requiresChannel } : {}),
      ...(m.params ? { params: m.params } : {}),
    }));
    // Only categories that ACTUALLY have points — the header lists every domain
    // category (list(CATEGORIES)), most empty on any given system; advertising an
    // empty one gives the model a target that resolves to nothing.
    const allCategories = Array.isArray(h.categories) ? h.categories : [];
    const present = new Set(Array.isArray(h.points?.category) ? h.points.category : []);
    const categories = allCategories.filter((_, i) => present.has(i));
    // The residue vocabulary: distinct FIRST TOKENS of subgroup labels ("ASP 33"
    // → "ASP"), BOUNDED — a system with thousands of distinct kinds must not
    // flood the context. Sorted, capped at SUBGROUP_KINDS_CAP.
    const SUBGROUP_KINDS_CAP = 40;
    const kindSet = new Set<string>();
    for (const label of Object.values(h.subgroups ?? {})) {
      const kind = String(label).trim().split(/\s+/)[0];
      if (kind) kindSet.add(kind);
    }
    const allKinds = [...kindSet].sort();
    const subgroupKinds = allKinds.slice(0, SUBGROUP_KINDS_CAP);
    // The point-type vocabulary: distinct point `type` strings (on a molecular
    // system, atom element symbols — C/N/O/…), sorted and capped like the
    // residue kinds. This is what makes `*.*.*.C` addressable instead of an
    // index list. Same cap; every advertised value resolves (get_context guard).
    const typeSet = new Set<string>();
    for (const t of Array.isArray(h.points?.type) ? h.points.type : []) {
      const tt = String(t).trim();
      if (tt) typeSet.add(tt);
    }
    const allTypes = [...typeSet].sort();
    const pointTypes = allTypes.slice(0, SUBGROUP_KINDS_CAP);
    return {
      system: h.name,
      nAtoms: h.n_points,
      nFrames: h.n_frames,
      categories,
      groups: Object.values(h.groups ?? {}),
      subgroupCount: Object.keys(h.subgroups ?? {}).length,
      subgroupKinds,
      subgroupKindsCapped: allKinds.length > subgroupKinds.length,
      pointTypes,
      pointTypesCapped: allTypes.length > pointTypes.length,
      // The real base look (representation.ts is the single source) so the model
      // states the true baseline for "put it back to normal" instead of guessing
      // — though undo is the reliable way back (Part C).
      // How the coordinates were prepared. Display and mods share ONE set of
      // coordinates, so a mod's numbers describe exactly what is on screen —
      // but only if the model can read what preparation was applied.
      provenance: Array.isArray(h.provenance) ? h.provenance : [],
      baseLook: {
        pointSize: DEFAULT_SIZE,
        opacity: DEFAULT_OPACITY,
        color: rgbToHex(DEFAULT_COLOR),
      },
      // The whole-system token is the BARE keyword `all` (address grammar);
      // `@all` is the union of committed SELECTIONS (empty with none), which is
      // what made the assistant's `@all` resolve to nothing. `categories` is now
      // only the present ones, so every example resolves non-empty — the
      // resolve-every-example guard (tests/get_context.test.ts) enforces it.
      targetExamples: buildTargetExamples(categories),
      committedSelections: ls.message,
      liveState,
      mods,
    };
  };

  const analysisModNames = (): string[] =>
    loadWorkspaceMods(producerLog, modPaths).map((m) => m.name);

  /** Push the workspace mods to the viewer and AWAIT its registration outcome
   * for `confirm` — the SAME id-correlated round-trip runViewerCommand uses (the
   * viewer answers on the commandResult channel; ids ≥ 1e6 never reach the
   * terminal). The viewer is the layer that actually registers a mod, so it is
   * the only layer entitled to say a mod was registered. */
  const pushWorkspaceMods = (confirm: string): Promise<{ ok: boolean; message: string }> =>
    new Promise((resolve) => {
      const id = assistantCmdSeq++;
      const timer = setTimeout(() => {
        pendingAsstAck.delete(id);
        resolve({ ok: false, message: "the viewer never confirmed the registration (timed out)" });
      }, 60_000);
      pendingAsstAck.set(id, (r) => { clearTimeout(timer); resolve(r); });
      void panel.webview.postMessage({
        type: "modsLoaded", mods: loadWorkspaceMods(producerLog, modPaths), id, confirm,
      });
    });

  const saveAssistantMod = async (spec: {
    name: string; produces: AnalysisMod["produces"]; axis?: AnalysisMod["axis"];
    description: string; code: string; params?: AnalysisMod["params"]; channel?: string;
    requiresChannel?: string;
  }): Promise<{ ok: boolean; name: string; file: string; message: string }> => {
    const mod: AnalysisMod = {
      kind: "analysis", name: spec.name, origin: "workspace",
      author: "Molaro assistant", produces: spec.produces,
      ...(spec.axis ? { axis: spec.axis } : {}),
      // P-2: the declared channel name becomes a `# channel:` header line. The
      // written file is re-parsed on registration, so a missing/invalid one on a
      // channel mod is caught and reported by write_mod, not silently accepted.
      ...(spec.channel ? { channel: spec.channel } : {}),
      // P-3: a required channel becomes a `# requires-channel:` header line.
      ...(spec.requiresChannel ? { requiresChannel: spec.requiresChannel } : {}),
      // Declared parameters become `# param:` header lines (serializeMod); the
      // written file is re-parsed on registration, so a malformed param is caught
      // and reported by write_mod, not silently accepted.
      ...(spec.params && spec.params.length ? { params: spec.params } : {}),
      description: spec.description, code: spec.code,
    };
    const { file, backup } = saveWorkspaceMod(mod);
    // A replacement is stated, not inferred. The human approved this mod's source,
    // not the disappearance of another — so say what was displaced and where it
    // went, in the same line that reports the write.
    const replaced = replacementNote(backup);
    // Re-parse the file we just wrote with the SAME parser registration uses, so
    // a malformed mod (e.g. produces: channel without a # channel: name) reports
    // its PRECISE reason to the model — the reload path only logs it and the
    // viewer would otherwise return the generic "not among the mods loaded".
    const reparsed = parseModFile(readFileSync(file, "utf-8"), "workspace");
    if (!reparsed.ok) {
      return { ok: false, name: spec.name, file, message: reparsed.error };
    }
    // The disk write is NOT the registration. Re-push and wait for the viewer to
    // say whether it took — write_mod reports what THIS answers, never the write.
    const r = await pushWorkspaceMods(spec.name);
    return { ok: r.ok, name: spec.name, file, message: `${r.message}${replaced}` };
  };

  // The GATED delete_mod tool's host action. Refuses everything that is not a
  // scanned workspace mod (built-ins/unknown/traversal, by construction — see
  // resolveModDeletion), unlinks the file, then reconciles the viewer registry
  // through the SAME `rm-mods-result` path rm uses (finishRmDeletion unregisters
  // the mod + its verb) so registry and disk cannot disagree. Reached only after
  // the approval gate; the tool surfaces {ok:false} as a refusal to the model.
  const deleteAssistantMod = (name: string): { ok: boolean; message: string } => {
    // Refresh the scan so modPaths reflects disk, then resolve ONLY via the map.
    loadWorkspaceMods(producerLog, modPaths);
    const resolved = resolveModDeletion(modPaths, name);
    if ("refused" in resolved) return { ok: false, message: resolved.refused };
    let alreadyGone = false;
    try {
      unlinkSync(resolved.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return { ok: false, message: `delete_mod failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      alreadyGone = true; // already removed on disk — still reconcile the registry
    }
    modPaths.delete(name);
    void panel.webview.postMessage({ type: "rm-mods-result", deleted: [name], failed: [] });
    return {
      ok: true,
      message: `deleted mod "${name}" (${resolved.file})${alreadyGone ? " — its file was already gone" : ""} — unregistered.`,
    };
  };

  const createRealBackend = async (): Promise<void> => {
    if (claudeBackend) return;
    const { model } = assistantConfig();
    const apiKey = await resolveApiKey(context);
    const backend = createClaudeBackend(
      (ev) => void terminal?.webview.postMessage(ev),
      {
        apiKey, model, authHint: NO_KEY_HINT,
        getSceneContext: assembleContext,
        getContext: async () => {
          const c = await assembleContext();
          if (!c) throw new Error("the system is still loading — try again in a moment");
          return c;
        },
        writeMod: async (spec) => saveAssistantMod(spec),
        deleteMod: async (name) => deleteAssistantMod(name),
        // Resolve the assistant's NATIVE parameters once with the SHARED resolver
        // (the same one the approval preview and the viewer use) so preview and
        // execution can never disagree, and refuse anything that won't survive the
        // invocation string (a bad type, or a value we can't round-trip). Only
        // then build the `<name> <target> ?k=v …` string the terminal also parses,
        // from the RESOLVED typed values (defaults filled). An unknown mod has no
        // schema — relay raw and let the viewer report it.
        runMod: (name, target, parameters) => {
          const mod = loadWorkspaceMods(producerLog, modPaths).find((m) => m.name === name);
          let paramStr = "";
          if (mod) {
            const resolved = resolveParameters(mod.params ?? [], new Map(Object.entries(parameters ?? {})));
            if (!resolved.ok) return Promise.resolve({ ok: false, message: `${name}: ${resolved.error}` });
            paramStr = formatModParams(resolved.values);
          } else if (parameters && Object.keys(parameters).length) {
            paramStr = formatModParams(parameters);
          }
          return runViewerCommand([name, target, paramStr].filter((s) => s !== "").join(" "));
        },
        runCommand: (text) => runViewerCommand(text),
        analysisModNames,
        runModParams: (name) =>
          loadWorkspaceMods(producerLog, modPaths).find((m) => m.name === name)?.params,
      },
    );
    claudeBackend = backend;
    liveBackends.add(backend);
  };

  // The plot panel — a third editor webview, create-on-demand. The HOST
  // holds the active series (plothost.ts, shared with the harness glue) and
  // re-pushes it on the page's plot-ready, so close→reopen restores the
  // plot with no webview retention.
  let plot: vscode.WebviewPanel | null = null;
  const openPlot = (): void => {
    if (plot) {
      plot.reveal(undefined, true);
      return;
    }
    plot = vscode.window.createWebviewPanel(
      "viewerPlot",
      `${opts.title} — Plot`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
      },
    );
    plot.webview.html = renderPlotHtml(plot.webview, context.extensionUri);
    plot.webview.onDidReceiveMessage((msg: unknown) => {
      plotHost.handlePlotMessage(msg);
    });
    plot.onDidDispose(() => {
      plot = null;
    });
  };
  const plotHost = createPlotHost({
    openPlot,
    postToPlot: (msg) => void plot?.webview.postMessage(msg),
    postToViewer: (msg) => void panel.webview.postMessage(msg),
    postToTerminal: (msg) => void terminal?.webview.postMessage(msg),
  });
  const openTerminal = (): void => {
    if (terminal) {
      terminal.reveal(undefined, true);
      return;
    }
    terminal = vscode.window.createWebviewPanel(
      "viewerTerminal",
      `${opts.title} — Terminal`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // Keep the terminal's DOM alive while its tab is backgrounded —
        // otherwise VS Code tears the webview down and recreates it empty,
        // wiping the output log, the input line, and the command history.
        // Trade-off: a hidden terminal holds its context in memory; for a
        // text-only surface that cost is negligible.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
      },
    );
    terminal.webview.html = renderTerminalHtml(terminal.webview, context.extensionUri);
    terminal.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (relaysTerminalMessageToViewer(msg?.type)) {
        // Relay to the VIEWER. per-frame-series claude-binds belong to the PLOT
        // — the plot host consumes them (validate, hold, draw, answer the ⤷
        // outcome); everything else (incl. confirm-answer, rm's y/n) relays to
        // the viewer. Dropping confirm-answer here made `rm` fail silently.
        if (plotHost.handleTerminalMessage(msg)) return;
        void panel.webview.postMessage(msg);
        return;
      }
      if (msg?.type === "claude-ready") {
        // The conversation panel's backend, at ITS boundary: instantiated
        // host-side per terminal ON the page's ready signal (a message posted
        // before the page listens would be lost — the opening auth-status must
        // never race the load). The REAL SDK backend by default; the scripted
        // stub behind a setting (and the E2E harness wires the stub in-page).
        if (claudeBackend) return;
        const { useStub } = assistantConfig();
        if (useStub) {
          claudeBackend = createClaudeStub(
            (ev) => void terminal?.webview.postMessage(ev),
            { frameCount: () => plotHost.nFrames() },
          );
        } else {
          void createRealBackend();
        }
        return;
      }
      const claudeCmd = parseClaudeCommand(msg);
      if (claudeCmd) claudeBackend?.handle(claudeCmd);
    });
    terminal.onDidDispose(() => {
      if (claudeBackend) {
        claudeBackend.dispose();
        liveBackends.delete(claudeBackend);
        claudeBackend = null;
      }
      terminal = null;
    });
  };

  const session: ViewerSession = { openTerminal };
  lastViewerSession = session;
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) lastViewerSession = session;
  });

  panel.webview.onDidReceiveMessage((msg: { type?: string; request?: unknown }) => {
    if (plotHost.handleViewerMessage(msg)) {
      // viewerInfo doubles as the viewer's boot signal — the workspace mods
      // ship once its listeners are provably live (the claude-ready lesson)
      if (msg?.type === "viewerInfo") {
        void panel.webview.postMessage({
          type: "modsLoaded",
          mods: loadWorkspaceMods(producerLog, modPaths),
        });
      }
      return;
    }
    if (msg?.type === "claude-bind") {
      // a VIEWER-originated series (an analysis mod's result) rides the same
      // plot route tool results do; scalar/command kinds never come this way
      plotHost.handleTerminalMessage(msg);
      return;
    }
    if (msg?.type === "rm-mods") {
      // rm's confirmed deletion: unlink ONLY paths recorded by the mod
      // scan (never derived from names — rm can touch nothing outside
      // .molaro/mods). Reply with what actually happened; the viewer
      // unregisters only the successes.
      const names = (msg as unknown as { names?: string[] }).names ?? [];
      const deleted: string[] = [];
      const failed: { name: string; error: string }[] = [];
      for (const name of names) {
        const file = modPaths.get(name);
        if (!file) {
          failed.push({ name, error: "no file recorded for this mod" });
          continue;
        }
        try {
          unlinkSync(file);
          modPaths.delete(name);
          deleted.push(name);
        } catch (err) {
          failed.push({ name, error: err instanceof Error ? err.message : String(err) });
        }
      }
      void panel.webview.postMessage({ type: "rm-mods-result", deleted, failed });
      return;
    }
    if (msg?.type === "toProducer" && msg.request) {
      try {
        broker.send(msg.request as { type: "header" | "frames" | "run_mod" });
      } catch (err) {
        void panel.webview.postMessage({
          type: "producerExit",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (msg?.type === "openTerminal") {
      openTerminal();
    } else if (msg?.type === "commandResult") {
      const cr = msg as unknown as { id: number; status: string; message: string };
      if (cr.id >= 1_000_000) {
        // an ASSISTANT command's ack — resolve its tool promise, or (for a mod
        // invocation) hold for the async id:-1 outcome. Never echoed to the
        // terminal (the user didn't type it).
        const ack = pendingAsstAck.get(cr.id);
        pendingAsstAck.delete(cr.id);
        if (cr.status === "ok" && MOD_ACK.test(cr.message ?? "")) {
          pendingModOutcome = ack ?? null;
          const captured = ack;
          setTimeout(() => {
            if (pendingModOutcome === captured) {
              pendingModOutcome = null;
              captured?.({ ok: true, message: cr.message });
            }
          }, 30_000);
        } else {
          ack?.({ ok: cr.status !== "error", message: cr.message });
        }
        return;
      }
      if (cr.id === -1 && pendingModOutcome) {
        const settle = pendingModOutcome;
        pendingModOutcome = null;
        settle({ ok: cr.status !== "error", message: cr.message });
      }
      void terminal?.webview.postMessage(msg);
    } else if (msg?.type === "completeResult" || msg?.type === "claude-bind-result") {
      void terminal?.webview.postMessage(msg);
    }
  });

  panel.onDidDispose(() => {
    broker.dispose();
    terminal?.dispose();
    plot?.dispose();
    if (lastViewerSession === session) lastViewerSession = null;
  });
  broker.start();
  panel.webview.html = renderHtml(panel.webview, context.extensionUri);
}

export function deactivate(): void {}

/**
 * Interpreter used for the real (mdtraj) source. mdtraj lives in the benchmark
 * `mdbench` conda env, not the base python, so real datasets need a capable
 * interpreter. Overridable via the VIEWER_PYTHON env var or the pythonPath
 * open-arg; the synthetic source ignores this and uses plain python3.
 */
function realPythonPath(): string {
  return process.env.VIEWER_PYTHON ?? "python3";
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js"),
  );
  // Development/measurement switch for the impostor depth variant (1 = flat
  // sprite depth, 2 = analytic gl_FragDepth). NOT a user surface — it exists
  // so the real-hardware measurement script can drive both variants against
  // the packaged extension. Anything but 2 means the provisional default (1:
  // early-Z kept, cannot regress frame rate on unmeasured hardware).
  const depthVariant =
    vscode.workspace.getConfiguration("molaro").get<number>("viewer.depthVariant", 2) === 1 ? 1 : 2;

  const csp = buildWebviewCsp({
    cspSource: webview.cspSource,
    nonce,
    allowDataImages: true,
    allowConnect: true,
  });

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Point Viewer</title>
  <style nonce="${nonce}">${HUD_CSS}</style>
</head>
<body>
  ${HUD_BODY}
  <script nonce="${nonce}">window.__VIEWER__ = { autoplay: false, depthVariant: ${depthVariant} };</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function renderPlotHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "plot.js"),
  );

  // allowDataImages is REQUIRED here: figures (produces: figure) render as a
  // base64 PNG `data:` <img>, and without img-src the default-src 'none'
  // fallback blocks it (the broken-image glyph). The E2E harness serves its
  // own HTML/CSP, so only the real extension exercises this — see
  // tests/webviewcsp.test.ts, which pins the invariant.
  const csp = buildWebviewCsp({
    cspSource: webview.cspSource,
    nonce,
    allowDataImages: true,
  });

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Point Viewer Plot</title>
  <style nonce="${nonce}">${PLOT_CSS}</style>
</head>
<body>
  ${PLOT_BODY}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function renderTerminalHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "terminal.js"),
  );

  const csp = buildWebviewCsp({ cspSource: webview.cspSource, nonce });

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Point Viewer Terminal</title>
  <style nonce="${nonce}">${TERMINAL_CSS}</style>
</head>
<body>
  ${TERMINAL_BODY}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
