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

      const panel = vscode.window.createWebviewPanel(
        "viewer",
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "webview")],
        },
      );

      const broker = new ProducerBroker(
        {
          pythonPath: args?.pythonPath ?? (isReal ? realPythonPath() : undefined),
          serveScript: vscode.Uri.joinPath(context.extensionUri, "producer", "serve.py").fsPath,
          producerArgs,
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
        }
      });

      panel.onDidDispose(() => broker.dispose());
      broker.start();
      panel.webview.html = renderHtml(panel.webview, context.extensionUri);
    }),
  );
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
