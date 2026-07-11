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
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProducerBroker } from "./broker.ts";
import { parseModFile, serializeMod, type AnalysisMod, type Mod } from "../webview/recipes.ts";
import { parseClaudeCommand, type ClaudeCommand } from "../webview/claudemodel.ts";
import { createClaudeStub } from "../webview/claudestub.ts";
import { createClaudeBackend, type ClaudeBackend } from "./claudebackend.ts";
import { buildTargetExamples, type SceneContext } from "./claudetools.ts";
import { relaysTerminalMessageToViewer } from "./hostmessages.ts";
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
  points: { category: number[] };
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

/** The save path a later authoring step writes through: serialize a mod to
 * `.molaro/mods/<name>.py`. Analysis mods only (serializeMod refuses R
 * mods — they are code, not files). */
export function saveWorkspaceMod(mod: Mod): string {
  const dir = modsDir();
  if (!dir) throw new Error("no workspace folder — nowhere to save mods");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${mod.name}.py`);
  writeFileSync(file, serializeMod(mod), "utf-8");
  return file;
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
    const mods = loadWorkspaceMods(producerLog, modPaths).map((m) => ({
      name: m.name, produces: m.produces, axis: m.axis, description: m.description,
    }));
    // Only categories that ACTUALLY have points — the header lists every domain
    // category (list(CATEGORIES)), most empty on any given system; advertising an
    // empty one gives the model a target that resolves to nothing.
    const allCategories = Array.isArray(h.categories) ? h.categories : [];
    const present = new Set(Array.isArray(h.points?.category) ? h.points.category : []);
    const categories = allCategories.filter((_, i) => present.has(i));
    return {
      system: h.name,
      nAtoms: h.n_points,
      nFrames: h.n_frames,
      categories,
      groups: Object.values(h.groups ?? {}),
      subgroupCount: Object.keys(h.subgroups ?? {}).length,
      // The whole-system token is the BARE keyword `all` (address grammar);
      // `@all` is the union of committed SELECTIONS (empty with none), which is
      // what made the assistant's `@all` resolve to nothing. `categories` is now
      // only the present ones, so every example resolves non-empty — the
      // resolve-every-example guard (tests/get_context.test.ts) enforces it.
      targetExamples: buildTargetExamples(categories),
      committedSelections: ls.message,
      mods,
    };
  };

  const analysisModNames = (): string[] =>
    loadWorkspaceMods(producerLog, modPaths).map((m) => m.name);

  const saveAssistantMod = (spec: {
    name: string; produces: AnalysisMod["produces"]; axis?: AnalysisMod["axis"];
    description: string; code: string;
  }): { name: string; file: string } => {
    const mod: AnalysisMod = {
      kind: "analysis", name: spec.name, origin: "workspace",
      author: "Molaro assistant", produces: spec.produces,
      ...(spec.axis ? { axis: spec.axis } : {}),
      description: spec.description, code: spec.code,
    };
    const file = saveWorkspaceMod(mod);
    // Re-register so the new mod appears in `mods` and its verb resolves — the
    // viewer re-derives its registry from this push, exactly like at startup.
    void panel.webview.postMessage({
      type: "modsLoaded", mods: loadWorkspaceMods(producerLog, modPaths),
    });
    return { name: spec.name, file };
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
        runMod: (name, target) => runViewerCommand(`${name} ${target}`.trim()),
        runCommand: (text) => runViewerCommand(text),
        analysisModNames,
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

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource}`,
  ].join("; ");

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
  <script nonce="${nonce}">window.__VIEWER__ = { autoplay: false };</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function renderPlotHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "plot.js"),
  );

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
  ].join("; ");

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

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
  ].join("; ");

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
