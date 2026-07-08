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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ProducerBroker } from "../src/broker.ts";
import { HUD_BODY, HUD_CSS } from "../webview/hud.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "8940" },
    "n-points": { type: "string", default: "5000" },
    "n-frames": { type: "string", default: "600" },
    // Real mdtraj source: --system <corpus id> spawns the producer under
    // --python (a mdtraj-capable interpreter, e.g. the mdbench conda env).
    system: { type: "string" },
    python: { type: "string", default: "python3" },
  },
});

const pendingResponses: http.ServerResponse[] = [];

const producerArgs = args.system
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

const harnessHtml = (hold: boolean, selftest = false) => /* html */ `<!DOCTYPE html>
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
      window.acquireVsCodeApi = () => ({
        postMessage(msg) {
          if (!msg || msg.type !== "toProducer") return;
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
    // results so a headless run can assert selection/sync/toggle behavior.
    // Harness-only. Waits for streaming to warm up, then walks the tree.
    setTimeout(() => {
      const log = (...a) => console.log("[selftest]", ...a);
      try {
        const cats = [...document.querySelectorAll("#sidebar .tree-row.selectable")];
        log("category rows:", cats.length);
        // Select the first (structured) category, expect tree+canvas readouts sync.
        cats[0].click();
        log("after category click: sidebar=", document.querySelector(".sel-readout").textContent,
            "| canvas=", document.getElementById("selreadout").textContent,
            "| active=", document.querySelectorAll(".tree-row.active").length);
        // Expand first category, then its first group, select first subgroup.
        document.querySelector("#sidebar .tree-row .caret").click();
        const groupCaret = document.querySelectorAll("#sidebar .tree-row .caret")[1];
        if (groupCaret) groupCaret.click();
        const subRow = [...document.querySelectorAll("#sidebar .tree-row.selectable")]
          .find((r) => /subgroup/.test(r.textContent));
        if (subRow) { subRow.click();
          log("after subgroup click: canvas=", document.getElementById("selreadout").textContent); }
        // The one representation control: bulk toggle.
        const btn = document.getElementById("bulk-toggle");
        log("bulk button:", btn.textContent, "display=", btn.style.display || "shown");
        btn.click();
        log("after bulk toggle:", btn.textContent);
        log("DONE");
      } catch (e) { log("ERROR", e && e.message); }
    }, 3000);
  </script>` : ""}
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/rpc") {
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
  } else if (req.url === "/" || req.url === "/harness.html" || req.url === "/hold" || req.url === "/selftest") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(harnessHtml(req.url === "/hold", req.url === "/selftest"));
  } else if (req.url === "/slow.png") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(TINY_PNG);
    }, 8000);
  } else if (req.url === "/main.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(readFileSync(join(root, "dist", "webview", "main.js")));
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
