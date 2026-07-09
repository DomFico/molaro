/**
 * Terminal webview — the text entry point to the command layer. Deliberately
 * DUMB: it holds no hierarchy and no domain state; it ships the typed string
 * out and prints whatever result comes back. All resolution/execution happens
 * viewer-side (webview/commands.ts), routed through the extension host:
 *
 *   terminal ──{type:"command", id, text}──▶ host ──▶ viewer (runCommand)
 *   terminal ◀─{type:"commandResult", id, status, message}── host ◀── viewer
 *
 * One output log + one single-line input; Enter submits; Up/Down walk the
 * command history (the in-progress line is kept as a draft). Built as its own
 * esbuild bundle (dist/webview/terminal.js) over the shared skeleton in
 * terminalhud.ts.
 */

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

interface CommandResultMsg {
  type: "commandResult";
  id: number;
  status: "ok" | "nomatch" | "error";
  message: string;
}

function main(): void {
  const host = acquireVsCodeApi();
  const log = document.getElementById("term-log");
  const input = document.getElementById("term-input") as HTMLInputElement | null;
  if (!log || !input) throw new Error("terminal: missing #term-log / #term-input");

  const print = (cls: string, text: string): void => {
    const el = document.createElement("div");
    el.className = `term-line ${cls}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  };

  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as CommandResultMsg | undefined;
    if (m?.type !== "commandResult") return;
    print(m.status === "error" ? "term-err" : m.status === "nomatch" ? "term-nomatch" : "term-ok", m.message);
  });

  let nextId = 1;
  const history: string[] = [];
  let histAt = -1; // -1 = the live (unsubmitted) line
  let draft = "";

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      const text = input.value.trim();
      if (!text) return;
      history.push(text);
      histAt = -1;
      draft = "";
      print("term-echo", `› ${text}`);
      host.postMessage({ type: "command", id: nextId++, text });
      input.value = "";
    } else if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      if (histAt === -1) {
        draft = input.value;
        histAt = history.length - 1;
      } else if (histAt > 0) {
        histAt--;
      }
      input.value = history[histAt];
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      if (histAt === -1) return;
      histAt++;
      if (histAt >= history.length) {
        histAt = -1;
        input.value = draft;
      } else {
        input.value = history[histAt];
      }
      e.preventDefault();
    }
  });

  input.focus();
}

main();
