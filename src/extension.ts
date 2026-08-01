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
import { collectChecks, renderReport } from "./diagnose.ts";
import { randomBytes } from "node:crypto";
import { buildWebviewCsp } from "./webviewcsp.ts";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ProducerBroker } from "./broker.ts";
import { parseModFile, resolveParameters, serializeMod, type AnalysisMod, type Mod } from "../webview/recipes.ts";
import { replacementNote, saveModFile, type ModWriteResult } from "./modfile.ts";
import { parseClaudeCommand, type ClaudeCommand } from "../webview/claudemodel.ts";
import { createClaudeStub } from "../webview/claudestub.ts";
import { DEFAULT_COLOR, DEFAULT_OPACITY, DEFAULT_SIZE } from "../webview/representation.ts";
import { createClaudeBackend, type ClaudeBackend } from "./claudebackend.ts";
import { buildTargetExamples, gatherLiveState, type SceneContext } from "./claudetools.ts";
import {
  producerOpenArgs,
  producerStatusFromLog,
  relaysTerminalMessageToViewer,
  resolveModDeletion,
} from "./hostmessages.ts";
import { clearApiKey, NO_KEY_HINT, promptAndStoreApiKey, resolveApiKey } from "./claudeauth.ts";
import { createPlotHost } from "../webview/plothost.ts";
import { HUD_BODY, HUD_CSS } from "../webview/hud.ts";
import { PLOT_BODY, PLOT_CSS } from "../webview/plothud.ts";
import { TERMINAL_BODY, TERMINAL_CSS } from "../webview/terminalhud.ts";

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
  /** Frame-cap override for a real dataset — see `molaro.viewer.maxFrames`. Takes
   * precedence over the setting; omit to use it. */
  maxFrames?: number;
  /** Bond-inference override for a real dataset — see `molaro.viewer.inferBonds`.
   * Takes precedence over the setting; omit to use it. */
  inferBonds?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  // The packaged mods that come standard (see loadAllMods). Set before any scan.
  shippedModsDirPath = join(context.extensionPath, "mods");
  const producerLog = vscode.window.createOutputChannel("Point Viewer Producer");
  context.subscriptions.push(producerLog);

  // WITHOUT THIS, A WINDOW RELOAD LEAVES A DEAD TAB. VS Code re-creates a webview
  // panel it saw before, and with no serializer registered the panel comes back
  // with no host behind it: no producer, no broker, no error — a viewer-shaped
  // corpse that looks like a hang. Restoring the SESSION is not possible (the
  // stream, the buffers and the undo history all lived in the old process), so
  // this rebuilds the panel honestly: dispose the husk and reopen with the same
  // producer args, which is what the user would have done by hand.
  // `Molaro: Diagnose` — the chain that has to hold, printed in order. Every row
  // is a failure that actually happened on a real install and presented as a
  // blank panel or an empty error.
  context.subscriptions.push(
    vscode.commands.registerCommand("viewer.diagnose", async () => {
      const channel = vscode.window.createOutputChannel("Molaro Diagnostics");
      context.subscriptions.push(channel);
      channel.show(true);
      channel.appendLine("running…");
      const configured = vscode.workspace
        .getConfiguration("molaro").get<string>("pythonPath")?.trim();
      const checks = await collectChecks({
        pythonPath: realPythonPath(),
        pythonSource: configured ? "molaro.pythonPath"
          : (process.env.VIEWER_PYTHON ? "VIEWER_PYTHON (legacy)" : "default python3"),
        modsDir: modsDir(),
      });
      channel.clear();
      channel.appendLine(renderReport(checks));
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("viewer", {
      async deserializeWebviewPanel(stale: vscode.WebviewPanel): Promise<void> {
        const opts = context.workspaceState.get<PanelOpts>(LAST_PANEL_OPTS);
        stale.dispose();
        if (!opts) {
          void vscode.window.showInformationMessage(
            "Molaro: this viewer could not be restored after the reload — open the dataset again.");
          return;
        }
        openPanel(context, producerLog, opts);
      },
    }),
  );

  // viewer.open — synthetic (default) or a benchmark system / explicit topology.
  context.subscriptions.push(
    vscode.commands.registerCommand("viewer.open", (args?: OpenArgs) => {
      const isReal = Boolean(args?.system || args?.topology);
      const { producerArgs, title } = producerOpenArgs({
        ...args,
        maxFrames: args?.maxFrames ?? configuredMaxFrames(),
        inferBonds: args?.inferBonds ?? configuredInferBonds(),
      });
      openPanel(context, producerLog, {
        producerArgs,
        title,
        // THE SYNTHETIC SOURCE NEEDS THE INTERPRETER TOO. It used to be handed
        // `undefined` on the reasoning that it reads no trajectory — but it still
        // imports numpy, so it spawned a bare `python3` and the Quick Start's very
        // first step failed on any machine whose default python lacks it. Measured
        // on a cluster: CVMFS python 3.11.4, no numpy.
        pythonPath: args?.pythonPath ?? realPythonPath(),
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
        // Through the SAME arg builder as viewer.open — this is the path the
        // Explorer context menu takes, so it is where a long trajectory actually
        // gets opened, and the frame cap must reach it.
        const { producerArgs, title } = producerOpenArgs({
          openPath: target.fsPath,
          maxFrames: configuredMaxFrames(),
          inferBonds: configuredInferBonds(),
        });
        openPanel(context, producerLog, {
          producerArgs,
          title,
          pythonPath: realPythonPath(),
        });
      },
    ),
  );
}

/** The `molaro.viewer.maxFrames` override for the producer's display frame cap.
 * 0 (the setting default) means "say nothing" — the producer applies its own
 * default, which stays the ONE source of that number (producer/source.py). A
 * positive value caps; a negative one loads every frame. */
function configuredMaxFrames(): number {
  return vscode.workspace.getConfiguration("molaro").get<number>("viewer.maxFrames", 0) || 0;
}

/** The bond-inference modes, host-side. THE THIRD COPY of this list (package.json's
 * enum and `producer/bond_inference.MODES` are the others), so it is ASSERTED
 * rather than remembered: tests/bond_inference.py block H reads this file AND
 * package.json and fails if either drifts from the producer's. */
const INFER_BONDS_MODES = ["full", "nonsolvent", "off"];

/** The `molaro.viewer.inferBonds` mode for the producer's covalent-bond inference.
 *
 * Forwarded, including the setting's own default — unlike `maxFrames`, whose 0
 * sentinel means "say nothing", because a NUMBER has no spare value and a settings
 * UI needs a real enum here to be usable.
 *
 * An empty value (a hand-cleared setting) forwards nothing, leaving the producer's
 * default. An UNKNOWN value forwards nothing either, with a warning naming the
 * valid ones. That is a deliberate reversal: this used to forward verbatim on the
 * argument that "the producer rejects an unknown mode loudly at open, which is one
 * gate rather than two that can disagree" — but the producer's rejection is
 * `argparse` refusing to start, so a single mistyped character in settings.json
 * (`"Full"`; VS Code's `enum` is a settings-UI dropdown and a JSON squiggle, not a
 * write barrier) meant NO dataset would open at all. A bad value for one feature
 * must not brick file opening; `maxFrames` coerces the same way with `|| 0`. The
 * producer keeps its loud gate for every path that is not a user's text editor —
 * the CLI, tests/bridge.ts, `viewer.open` args — where a typo is a bug, not a
 * setting. */
function configuredInferBonds(): string {
  const raw = (
    vscode.workspace.getConfiguration("molaro").get<string>("viewer.inferBonds", "") || ""
  ).trim();
  if (raw === "" || INFER_BONDS_MODES.includes(raw)) return raw;
  vscode.window.showWarningMessage(
    `molaro.viewer.inferBonds: unknown value ${JSON.stringify(raw)} — ` +
      `using the default. Valid values: ${INFER_BONDS_MODES.join(", ")}.`,
  );
  return "";
}

/** The mods directory (persistence lives here; nothing else does): the
 * `molaro.modsDir` setting when set (a leading `~` expands to the home
 * directory), else the GLOBAL default `~/.molaro/mods`. Never null — a global
 * directory exists independent of any workspace folder, so mods survive
 * across workspaces and opening a bare file still has somewhere to save. */
function modsDir(): string {
  const configured = vscode.workspace.getConfiguration("molaro").get<string>("modsDir")?.trim();
  if (configured) {
    if (configured === "~") return homedir();
    if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
    return configured;
  }
  return join(homedir(), ".molaro", "mods");
}

/** The SHIPPED mods directory — `<extension>/mods`, packaged inside the VSIX.
 * Read-only by nature: it lives under the installed extension, not in user
 * space, which is exactly why a shipped mod cannot be deleted (see
 * `loadShippedMods`). Set once at activation; "" before that (and in a unit
 * test that never activates), which makes the scan a no-op rather than a
 * crash. */
let shippedModsDirPath = "";

/** Startup scan of `<dir>/*.py` — parse each with the shared pure parser; a
 * malformed file is SKIPPED with a reported warning (one bad mod must never
 * break startup or the registry). `origin` is ASSIGNED here, never read from
 * the file. Only a scan that records into `modPaths` can ever be deleted. */
function scanModDir(
  dir: string,
  origin: "built-in" | "workspace",
  log: vscode.OutputChannel,
  modPaths?: Map<string, string>,
): AnalysisMod[] {
  let files: string[];
  try {
    if (origin === "workspace") mkdirSync(dir, { recursive: true }); // the global dir always exists
    files = readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
  } catch {
    return []; // unreadable/uncreatable/absent dir — nothing to load
  }
  const mods: AnalysisMod[] = [];
  for (const file of files) {
    try {
      const parsed = parseModFile(readFileSync(join(dir, file), "utf-8"), origin);
      if (parsed.ok) {
        mods.push(parsed.mod);
        // rm's name → file map: deletion uses ONLY paths recorded by this
        // scan (the mod's name comes from the header, not the filename),
        // which is what confines rm to the mods dir forever. A SHIPPED mod is
        // deliberately never recorded, so `rm`/`delete_mod` cannot resolve it
        // and refuse through the existing built-in path — no new guard.
        modPaths?.set(parsed.mod.name, join(dir, file));
      } else log.appendLine(`[mods] skipped ${file}: ${parsed.error}`);
    } catch (err) {
      log.appendLine(`[mods] skipped ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return mods;
}

/** Every mod the registry should hold: the SHIPPED set that comes with the
 * package, then the user's own, with a WORKSPACE MOD OF THE SAME NAME WINNING.
 *
 * Shadowing is the point, not an accident: a user who wants to change a shipped
 * mod's EDIT-ME globals copies it into their mods dir and edits there, and the
 * shipped original stays intact underneath for the next install to restore. The
 * `Mod` object carries its own Python source, so a shipped mod needs no file
 * path at run time and works identically to a workspace one. */
function loadAllMods(
  log: vscode.OutputChannel,
  modPaths?: Map<string, string>,
): AnalysisMod[] {
  modPaths?.clear();
  // Shipped first: it must NOT populate modPaths, so scan it with no map.
  const shipped = shippedModsDirPath ? scanModDir(shippedModsDirPath, "built-in", log) : [];
  const dir = modsDir();
  const workspace = scanModDir(dir, "workspace", log, modPaths);
  const overridden = new Set(workspace.map((m) => m.name));
  const kept = shipped.filter((m) => !overridden.has(m.name));
  const shadowed = shipped.length - kept.length;
  if (kept.length > 0) log.appendLine(`[mods] loaded ${kept.length} shipped mod(s) from ${shippedModsDirPath}`);
  if (shadowed > 0) log.appendLine(`[mods] ${shadowed} shipped mod(s) shadowed by a workspace mod of the same name`);
  if (workspace.length > 0) log.appendLine(`[mods] loaded ${workspace.length} workspace mod(s) from ${dir}`);
  return [...kept, ...workspace];
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
 * `<modsDir()>/<name>.py`. Analysis mods only (serializeMod refuses R
 * mods — they are code, not files). The write itself lives in src/modfile.ts,
 * which is vscode-free and therefore testable — it creates the directory if
 * missing, preserves any prior file rather than clobbering it, and reports
 * what it displaced. modsDir() is never null (a global dir always exists), so
 * there is no "no workspace folder" failure mode any more. */
export function saveWorkspaceMod(mod: Mod): ModWriteResult {
  return saveModFile(modsDir(), mod.name, serializeMod(mod));
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

/** workspaceState key holding the last panel's opts, for reload restore. */
const LAST_PANEL_OPTS = "molaro.lastPanelOpts";

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
  // Remember WHAT this panel was, so a window reload can rebuild it. A webview's
  // own getState/setState survives, but the producer args live on the host side
  // and the extension host restarts too — so they go in workspaceState.
  void context.workspaceState.update(LAST_PANEL_OPTS, opts);
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
  // The producer's most recent coarse loading line (stderr → onLog). Cached so
  // the boot race can't swallow it: a line emitted before the webview's listener
  // is live is re-posted when the webview first speaks (its header request).
  let lastProducerStatus: string | null = null;
  let flushedProducerStatus = false;
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
      onLog: (line) => {
        producerLog.appendLine(line);
        // Surface the producer's coarse loading step to the viewer's loading
        // overlay (the big-topology "not frozen" signal). This is the one signal
        // available while the producer blocks parsing a large dataset before the
        // serve loop starts — a plain stderr line, never an out-of-band protocol
        // frame (which would break the transport's FIFO correlation).
        const status = producerStatusFromLog(line);
        if (status) {
          lastProducerStatus = status;
          void panel.webview.postMessage({ type: "producerStatus", text: status });
        }
      },
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
    const mods = loadAllMods(producerLog, modPaths).map((m) => ({
      name: m.name, produces: m.produces, axis: m.axis, description: m.description,
      ...(m.channel ? { channel: m.channel } : {}),
      ...(m.edgeGroup ? { edgeGroup: m.edgeGroup } : {}),
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
    loadAllMods(producerLog, modPaths).map((m) => m.name);

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
        type: "modsLoaded", mods: loadAllMods(producerLog, modPaths), id, confirm,
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
    loadAllMods(producerLog, modPaths);
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
          const mod = loadAllMods(producerLog, modPaths).find((m) => m.name === name);
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
          loadAllMods(producerLog, modPaths).find((m) => m.name === name)?.params,
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
          mods: loadAllMods(producerLog, modPaths),
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
    if (msg?.type === "save-mod") {
      // save_rep's host mod-file write: write ONLY <modsDir()>/<name>.py via the
      // SAME backup-preserving writer write_mod uses (saveModFile), then re-scan
      // disk (which also refreshes modPaths) and re-push modsLoaded so <name>
      // registers as a live verb — exactly as write_mod's re-push and the
      // hot-reload watcher do. The write is NOT the registration; the re-push is,
      // so it goes out BEFORE the result line. NOT undoable (the filesystem is
      // outside the undo model — the rm precedent). Reply with what happened.
      const name = (msg as unknown as { name?: string }).name ?? "";
      const source = (msg as unknown as { source?: string }).source ?? "";
      try {
        const { file, backup } = saveModFile(modsDir(), name, source);
        void panel.webview.postMessage({
          type: "modsLoaded",
          mods: loadAllMods(producerLog, modPaths),
        });
        void panel.webview.postMessage({ type: "save-mod-result", name, file, backup });
      } catch (err) {
        void panel.webview.postMessage({
          type: "save-mod-result",
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (msg?.type === "toProducer" && msg.request) {
      // The webview's first request (its boot header ask) proves its listener is
      // live — flush any loading status that was emitted before then, so the
      // overlay shows the producer's own words rather than only the generic copy.
      if (!flushedProducerStatus) {
        flushedProducerStatus = true;
        if (lastProducerStatus) {
          void panel.webview.postMessage({ type: "producerStatus", text: lastProducerStatus });
        }
      }
      try {
        // STAMP THE MOD TIMEOUT HERE, the single point every mod run passes.
        // `timeout_s` has been on the wire and honoured by the producer all along,
        // and NOTHING EVER SENT IT — so the producer's 5 s floor was effectively
        // hardcoded with no way to raise it. The webview builds this request and
        // has no access to configuration, so the host is the only place it can be
        // added. An explicit value still wins; 0 or negative falls through to the
        // producer's own floor, because a hang guard should be raisable but not
        // removable.
        const req = msg.request as { type: "header" | "frames" | "run_mod"; timeout_s?: number };
        if (req.type === "run_mod" && req.timeout_s === undefined) {
          const secs = vscode.workspace
            .getConfiguration("molaro").get<number>("modTimeoutSeconds");
          if (typeof secs === "number" && secs > 0) req.timeout_s = secs;
        }
        broker.send(req);
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

  // -- mod hot-reload: watch <modsDir()>/*.py so a hand-edit to a mod file
  // lands without reopening the panel (mods were previously parsed+registered
  // only at panel creation; the run path never re-reads disk). Create/change/
  // delete each re-scan (debounced — an editor save can fire several events)
  // and re-post through the EXISTING modsLoaded re-push: the webview's install
  // path REPLACES a re-pushed mod's recipe entry and its command handler (the
  // handler closes over the mod object), so the next run uses the new code.
  // A file deleted on disk stays registered until rm/delete_mod or reload —
  // deletion keeps its own gated reconcile path; the watcher only refreshes
  // what the scan finds. The dir is ensured first: a watcher on a not-yet-
  // existing directory would never fire.
  // NEVER LET A BAD SETTING TAKE THE VIEWER DOWN. This threw, and because
  // openPanel creates the panel BEFORE it gets here and starts the broker AFTER,
  // the failure produced a tab that appeared, stayed blank forever, spawned no
  // producer, and reported a permission error that read like a broken filesystem.
  // MEASURED on a cluster: a user-scoped `molaro.modsDir` holding a LAPTOP path
  // reached a remote window (VS Code applies user settings to remote hosts), so
  // the mkdir was for a directory whose parent is root-owned and does not exist.
  // A mods folder is a convenience; it must not be able to stop you seeing data.
  let modsRoot = modsDir();
  try {
    mkdirSync(modsRoot, { recursive: true });
  } catch (err) {
    const fallback = join(homedir(), ".molaro", "mods");
    producerLog.appendLine(
      `molaro: cannot use mods directory ${modsRoot} (${(err as Error).message}). ` +
      `Falling back to ${fallback}. Check the "molaro.modsDir" setting — if it came ` +
      `from another machine, note that path settings are machine-scoped for exactly ` +
      `this reason.`);
    vscode.window.showWarningMessage(
      `Molaro: mods directory "${modsRoot}" is unusable — using ${fallback} instead.`);
    modsRoot = fallback;
    try { mkdirSync(modsRoot, { recursive: true }); } catch { /* watcher just won't fire */ }
  }
  const modsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(modsRoot), "*.py"),
  );
  let modsReloadTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleModsReload = (): void => {
    if (modsReloadTimer) clearTimeout(modsReloadTimer);
    modsReloadTimer = setTimeout(() => {
      modsReloadTimer = null;
      void panel.webview.postMessage({
        type: "modsLoaded",
        mods: loadAllMods(producerLog, modPaths),
      });
    }, 200);
  };
  modsWatcher.onDidCreate(scheduleModsReload);
  modsWatcher.onDidChange(scheduleModsReload);
  modsWatcher.onDidDelete(scheduleModsReload);

  panel.onDidDispose(() => {
    if (modsReloadTimer) clearTimeout(modsReloadTimer);
    modsWatcher.dispose();
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
  // A SETTING FIRST, and the environment only as a legacy fallback.
  //
  // `VIEWER_PYTHON` is unreachable on a remote host in the common case, and the
  // reason is not obvious: VS Code's CLI keeps a LONG-LIVED daemon that survives
  // disconnects and spawns every server as its child, so servers inherit the
  // DAEMON's environment — not your shell's, and not a fresh login's. MEASURED on
  // a cluster: a daemon two days old, and "Kill VS Code Server on Host" does not
  // touch it. `~/.vscode-server/server-env-setup` is widely cited and is not read
  // by the CLI-based server at all.
  //
  // A setting crosses the remote boundary through VS Code's own configuration and
  // applies on extension-host reload, independent of process lineage. So: never
  // configure a remote extension through the environment.
  const configured = vscode.workspace
    .getConfiguration("molaro").get<string>("pythonPath")?.trim();
  if (configured) {
    if (configured === "~") return homedir();
    if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
    return configured;
  }
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
  // The hold gesture runs a COMMAND TEMPLATE, not a named operation. The viewer
  // substitutes the resolved target for {target} and runs the result through the
  // ordinary command path, so it stays domain-free: it knows "run this string",
  // which is the same thing typing knows. Empty disables the gesture.

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
  <script nonce="${nonce}">window.__VIEWER__ = ${JSON.stringify({ autoplay: false, depthVariant })};</script>
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
