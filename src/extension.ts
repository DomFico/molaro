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

import { ProducerBroker } from "./broker.ts";
import { HUD_BODY, HUD_CSS } from "../webview/hud.ts";
import { TERMINAL_BODY, TERMINAL_CSS } from "../webview/terminalhud.ts";

const DEFAULT_N_POINTS = 20_000;
const DEFAULT_N_FRAMES = 600;

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
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
    },
  );

  const broker = new ProducerBroker(
    {
      pythonPath: opts.pythonPath,
      serveScript: vscode.Uri.joinPath(context.extensionUri, "producer", "serve.py").fsPath,
      producerArgs: opts.producerArgs,
    },
    {
      onMessage: (payload) => {
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
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
      },
    );
    terminal.webview.html = renderTerminalHtml(terminal.webview, context.extensionUri);
    terminal.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === "command" || msg?.type === "complete") {
        void panel.webview.postMessage(msg);
      }
    });
    terminal.onDidDispose(() => {
      terminal = null;
    });
  };

  const session: ViewerSession = { openTerminal };
  lastViewerSession = session;
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) lastViewerSession = session;
  });

  panel.webview.onDidReceiveMessage((msg: { type?: string; request?: unknown }) => {
    if (msg?.type === "toProducer" && msg.request) {
      try {
        broker.send(msg.request as { type: "header" | "frames" });
      } catch (err) {
        void panel.webview.postMessage({
          type: "producerExit",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (msg?.type === "openTerminal") {
      openTerminal();
    } else if (msg?.type === "commandResult" || msg?.type === "completeResult") {
      void terminal?.webview.postMessage(msg);
    }
  });

  panel.onDidDispose(() => {
    broker.dispose();
    terminal?.dispose();
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
