/**
 * Headless E2E bridge — test infrastructure, not product code.
 *
 * Lets the real webview bundle run in a plain browser while still exercising
 * the real host broker and the real Python producer:
 *
 *   browser (webview bundle) ⇄ HTTP /rpc ⇄ bridge (ProducerBroker) ⇄ stdio ⇄ serve.py
 *
 * The served harness page mimics the VS Code webview: same DOM skeleton, a
 * strict nonce'd CSP, and an acquireVsCodeApi() shim that maps postMessage to
 * fetch("/rpc"). Producer responses are matched FIFO bridge-side; the shim
 * re-dispatches them to the page in request order (buffering out-of-order
 * fetch completions), preserving the transport's FIFO correlation contract.
 *
 * Also samples the producer's RSS from /proc every 2s to stderr, so a stress
 * run can verify the producer's memory stays flat.
 *
 * Run from viewer/:  node tests/bridge.ts --port 8940 --n-points 5000 --n-frames 600
 */
import http from "node:http";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ProducerBroker } from "../src/broker.ts";
import { HUD_BODY, HUD_CSS } from "../webview/hud.ts";
import { PLOT_BODY, PLOT_CSS } from "../webview/plothud.ts";
import { parseModFile, type AnalysisMod } from "../webview/recipes.ts";
import { TERMINAL_BODY, TERMINAL_CSS } from "../webview/terminalhud.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The harness's workspace mods: the REAL example files from .molaro/mods
// (the same pure parser the extension host uses) plus one deliberately
// broken runtime mod (out-of-range scalars) so the fail-closed no-write
// path is drivable end-to-end.
function harnessMods(): AnalysisMod[] {
  const mods: AnalysisMod[] = [];
  try {
    for (const f of readdirSync(join(root, ".molaro", "mods")).filter((x) => x.endsWith(".py")).sort()) {
      const parsed = parseModFile(readFileSync(join(root, ".molaro", "mods", f), "utf-8"), "workspace");
      if (parsed.ok) mods.push(parsed.mod);
      else console.error(`[bridge] skipped mod ${f}: ${parsed.error}`);
    }
  } catch {
    /* no .molaro/mods — fine */
  }
  mods.push({
    name: "broken_ramp",
    kind: "analysis",
    produces: "per-point-scalar",
    axis: "color",
    code: "def compute(data, target_indices):\n    return [2.5 for _ in target_indices]\n",
    origin: "workspace",
    description: "harness-only: returns out-of-range scalars (the fail-closed path)",
  });
  return mods;
}
const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "8940" },
    "n-points": { type: "string", default: "5000" },
    "n-frames": { type: "string", default: "600" },
    // Real mdtraj source: --system <corpus id> spawns the producer under
    // --python (a mdtraj-capable interpreter, e.g. the mdbench conda env).
    system: { type: "string" },
    // Open a file directly (Increment 4.6): --open <path> under --python.
    open: { type: "string" },
    python: { type: "string", default: "python3" },
  },
});

const pendingResponses: http.ServerResponse[] = [];

const producerArgs = args.open
  ? ["--open", args.open]
  : args.system
    ? ["--system", args.system]
    : ["--n-points", args["n-points"]!, "--n-frames", args["n-frames"]!];

const broker = new ProducerBroker(
  {
    pythonPath: args.python,
    serveScript: join(root, "producer", "serve.py"),
    producerArgs,
  },
  {
    onMessage: (payload) => {
      const res = pendingResponses.shift();
      if (!res) {
        console.error("[bridge] response with no waiting rpc — aborting");
        process.exit(1);
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
    },
    onExit: (reason) => {
      console.error(`[bridge] producer exit: ${reason}`);
      for (const res of pendingResponses.splice(0)) {
        res.writeHead(500);
        res.end(reason);
      }
    },
    onLog: (line) => console.error(`[bridge] ${line}`),
  },
);
broker.start();

setInterval(() => {
  try {
    const status = readFileSync(`/proc/${broker.pid}/status`, "utf-8");
    const rss = /VmRSS:\s+(\d+) kB/.exec(status);
    if (rss) console.error(`[bridge-rss] ${Number(rss[1]) * 1024}`);
  } catch {
    /* producer gone */
  }
}, 2000).unref();

const NONCE = "harness-nonce";
// 1x1 PNG, served slowly by /slow.png to hold the load event open so a
// real-time --screenshot run captures mid-playback pixels.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const harnessHtml = (hold: boolean, selftest = false, terminal = false) => /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'nonce-${NONCE}'; img-src 'self' data:; connect-src 'self';">
  <title>viewer harness</title>
  <style nonce="${NONCE}">${HUD_CSS}</style>
</head>
<body>
  ${HUD_BODY}
  ${hold ? '<img id="holdopen" src="/slow.png" width="1" height="1" alt="">' : ""}
  <script nonce="${NONCE}">
    window.__VIEWER__ = { autoplay: true, statsLog: true, screenshotMode: true, test: true };
    // Headless Chrome under --virtual-time-budget never fires rAF (timers only),
    // so back the render loop with setTimeout. Harness-only; the real webview
    // uses native rAF.
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    (() => {
      let sendSeq = 0, dispatchSeq = 0;
      const ready = new Map();
      const flush = () => {
        while (ready.has(dispatchSeq)) {
          const payload = ready.get(dispatchSeq);
          ready.delete(dispatchSeq);
          const data = payload === null
            ? { type: "producerExit", message: "bridge rpc failed" }
            : { type: "fromProducer", payload };
          window.dispatchEvent(new MessageEvent("message", { data }));
          dispatchSeq++;
        }
      };
      // Mirror the extension host's workspace-mod push: when the viewer
      // announces itself (viewerInfo), ship the parsed .molaro/mods files —
      // the same signal-then-push pattern production uses.
      window.__HARNESS_MODS__ = ${JSON.stringify(harnessMods())};
      window.addEventListener("message", (e) => {
        if (e.data?.type === "viewerInfo") {
          setTimeout(() => window.dispatchEvent(new MessageEvent("message", {
            data: { type: "modsLoaded", mods: window.__HARNESS_MODS__ },
          })), 0);
        }
      });
      // webview state shim: sessionStorage-backed so persisted layout
      // survives a same-tab reload (the E2E restore assertion) but never
      // leaks across browser launches / reused chrome profiles.
      let __wvState;
      try { __wvState = JSON.parse(sessionStorage.getItem("__webview_state__") ?? "null") ?? undefined; }
      catch { __wvState = undefined; }
      window.acquireVsCodeApi = () => ({
        getState: () => __wvState,
        setState(s) {
          __wvState = s;
          try { sessionStorage.setItem("__webview_state__", JSON.stringify(s)); } catch {}
        },
        postMessage(msg) {
          if (!msg) return;
          // HOST LOOPBACK: the real extension host relays these verbatim
          // between the viewer and terminal panels; in the single-page
          // harness both live in one document, so re-dispatch as an incoming
          // message (async, mirroring postMessage delivery).
          if (msg.type === "command" || msg.type === "commandResult" ||
              msg.type === "complete" || msg.type === "completeResult" ||
              msg.type === "openTerminal" ||
              // conversation-panel commands: the real host routes these to
              // the claude backend (stub); the harness loops them back to
              // the page, where terminal.ts's harness glue feeds the SAME
              // stub module (see __TERMINAL_HARNESS__ below).
              msg.type === "user-message" || msg.type === "approval-decision" ||
              msg.type === "cancel" || msg.type === "claude-ready" ||
              msg.type === "claude-bind" || msg.type === "claude-bind-result" ||
              // plot orchestration: the viewer's frame signals and the plot
              // page's own posts loop back for the in-page plot-host glue
              msg.type === "viewerInfo" || msg.type === "frameChanged" ||
              msg.type === "plotSeek" || msg.type === "plot-ready" ||
              // rm: the confirmation answer and the deletion round-trip
              msg.type === "confirm-answer" || msg.type === "rm-mods") {
            setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: msg })), 0);
            return;
          }
          if (msg.type !== "toProducer") return;
          const seq = sendSeq++;
          fetch("/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(msg.request),
          })
            .then(async (r) => {
              if (!r.ok) throw new Error("rpc status " + r.status);
              ready.set(seq, new Uint8Array(await r.arrayBuffer()));
              flush();
            })
            .catch((e) => {
              console.error("[harness] rpc failed:", e);
              ready.set(seq, null);
              flush();
            });
        },
      });
    })();
  </script>
  <script nonce="${NONCE}" src="/main.js"></script>
  ${selftest ? `<script nonce="${NONCE}">
    // E2E self-test: drives the real DOM (clicks) the way a user would and logs
    // results so a headless run can assert the selection/hidden set behavior.
    // Harness-only. Waits for streaming to warm up, then walks the tree.
    setTimeout(() => {
      const log = (...a) => console.log("[selftest]", ...a);
      const sel = () => document.querySelector('.set-title.sel').textContent;
      try {
        const cats = [...document.querySelectorAll("#tree-host .tree-row.selectable")];
        log("category rows:", cats.length);
        // Left-click a category selects it (green).
        cats[0].click();
        log("after category select:", sel(), "| selected rows:", document.querySelectorAll(".tree-row.selected").length);
        // Right-click a category hides it (a hidden entry).
        cats[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        log("after right-click hide:", document.querySelector('.set-title.hid').textContent,
            "| hidden rows:", document.querySelectorAll(".tree-row.hidden-entry").length);
        log("DONE");
      } catch (e) { log("ERROR", e && e.message); }
    }, 3000);
  </script>` : ""}
  ${terminal ? `
  <!-- terminal smoke surface: the REAL terminal bundle over the REAL viewer,
       host routing emulated by the shim's loopback above. The flag makes
       terminal.ts wire the claude stub AND the plot host in-page (the
       host-side logic, emulated at the same boundary the loopback emulates
       the relay). The plot surface sits UNDER the terminal stack (z-50 <
       z-100): its SVG is asserted by DOM/attribute, and seek clicks are
       dispatched synthetically, so occlusion is irrelevant. -->
  <style nonce="${NONCE}">${TERMINAL_CSS}</style>
  <style nonce="${NONCE}">${PLOT_CSS}
    #plot-harness { position: absolute; inset: 0; z-index: 50; }
    #plot-harness #plot-root { position: absolute; inset: 0; }
  </style>
  <div id="plot-harness">${PLOT_BODY}</div>
  ${TERMINAL_BODY}
  <script nonce="${NONCE}">window.__TERMINAL_HARNESS__ = true;</script>
  <script nonce="${NONCE}" src="/terminal.js"></script>
  <script nonce="${NONCE}" src="/plot.js"></script>` : ""}
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/rm-mods") {
    // the extension host's rm-mods handler, emulated node-side: unlink ONLY
    // files found by a fresh scan of .molaro/mods (names map to files via
    // each file's parsed header, exactly like the host's recorded map)
    const body: Buffer[] = [];
    req.on("data", (d: Buffer) => body.push(d));
    req.on("end", () => {
      let names: string[] = [];
      try {
        names = (JSON.parse(Buffer.concat(body).toString("utf-8")) as { names?: string[] }).names ?? [];
      } catch { /* fall through to empty */ }
      const dir = join(root, ".molaro", "mods");
      const paths = new Map<string, string>();
      try {
        for (const f of readdirSync(dir).filter((x) => x.endsWith(".py"))) {
          const parsed = parseModFile(readFileSync(join(dir, f), "utf-8"), "workspace");
          if (parsed.ok) paths.set(parsed.mod.name, join(dir, f));
        }
      } catch { /* no dir */ }
      const deleted: string[] = [];
      const failed: { name: string; error: string }[] = [];
      for (const name of names) {
        const file = paths.get(name);
        if (!file) {
          failed.push({ name, error: "no file recorded for this mod" });
          continue;
        }
        try {
          unlinkSync(file);
          deleted.push(name);
        } catch (err) {
          failed.push({ name, error: err instanceof Error ? err.message : String(err) });
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ deleted, failed }));
    });
  } else if (req.method === "POST" && req.url === "/rpc") {
    const body: Buffer[] = [];
    req.on("data", (d: Buffer) => body.push(d));
    req.on("end", () => {
      // Queue the response BEFORE sending — producer replies are FIFO with sends.
      pendingResponses.push(res);
      try {
        broker.send(JSON.parse(Buffer.concat(body).toString("utf-8")));
      } catch (err) {
        pendingResponses.pop();
        res.writeHead(500);
        res.end(String(err));
      }
    });
  } else if (
    req.url === "/" || req.url === "/harness.html" || req.url === "/hold" ||
    req.url === "/selftest" || req.url === "/terminal"
  ) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(harnessHtml(req.url === "/hold", req.url === "/selftest", req.url === "/terminal"));
  } else if (req.url === "/slow.png") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(TINY_PNG);
    }, 8000);
  } else if (req.url === "/main.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(readFileSync(join(root, "dist", "webview", "main.js")));
  } else if (req.url === "/plot.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(readFileSync(join(root, "dist", "webview", "plot.js")));
  } else if (req.url === "/terminal.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(readFileSync(join(root, "dist", "webview", "terminal.js")));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(Number(args.port), "127.0.0.1", () => {
  console.error(`[bridge] listening on http://127.0.0.1:${args.port}/ (producer pid ${broker.pid})`);
});

process.on("SIGTERM", () => {
  broker.dispose();
  process.exit(0);
});
process.on("SIGINT", () => {
  broker.dispose();
  process.exit(0);
});
