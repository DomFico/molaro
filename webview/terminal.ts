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

import { parseClaudeCommand, parseClaudeEvent } from "./claudemodel.ts";
import { mountClaudePanel } from "./claudepanel.ts";
import { createClaudeStub } from "./claudestub.ts";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

interface CommandResultMsg {
  type: "commandResult";
  id: number;
  status: "ok" | "nomatch" | "error";
  message: string;
}

interface CompleteResultMsg {
  type: "completeResult";
  id: number;
  start: number;
  candidates: string[];
  applied: string;
  kind?: "filter";
}

function main(): void {
  const host = acquireVsCodeApi();
  const log = document.getElementById("term-log");
  const input = document.getElementById("term-input") as HTMLInputElement | null;
  if (!log || !input) throw new Error("terminal: missing #term-log / #term-input");

  // The conversation panel (/claude): its commands ride the SAME relay as
  // command/complete — the host routes them to the backend (the stub today).
  const claudePanel = mountClaudePanel((cmd) => host.postMessage(cmd));

  // HARNESS-ONLY: the smoke/E2E page has no extension host, so the bridge
  // shim loops panel commands back into the page and this glue feeds them to
  // the SAME stub module the real host instantiates (claudestub.ts) — the
  // identical code at an emulated boundary, exactly how the shim emulates
  // the command relay. Like the real host, the stub is created on the
  // terminal's "claude-ready" signal (below), so its first auth-status can
  // never race the listeners. Production never sets the flag.
  if ((window as unknown as { __TERMINAL_HARNESS__?: boolean }).__TERMINAL_HARNESS__) {
    let stub: ReturnType<typeof createClaudeStub> | null = null;
    window.addEventListener("message", (e: MessageEvent) => {
      if ((e.data as { type?: string } | undefined)?.type === "claude-ready") {
        stub ??= createClaudeStub((ev) => {
          window.dispatchEvent(new MessageEvent("message", { data: ev }));
        });
        return;
      }
      const cmd = parseClaudeCommand(e.data);
      if (cmd) stub?.handle(cmd);
    });
  }

  const print = (cls: string, text: string): void => {
    const el = document.createElement("div");
    el.className = `term-line ${cls}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  };

  // Completion previews (candidate lists / cap hints) are INFORMATIONAL: a
  // repeated Tab on an unchanged input must not stack duplicate copies. We
  // suppress a re-print when the identical preview is already the last log
  // line; any command output in between makes the next preview print again.
  let lastPreview: HTMLElement | null = null;
  const printCompletionPreview = (text: string): void => {
    if (
      lastPreview !== null &&
      lastPreview.isConnected &&
      lastPreview === log.lastElementChild &&
      lastPreview.textContent === text
    ) {
      return; // the same preview is already showing — don't stack another
    }
    const el = document.createElement("div");
    el.className = "term-line term-echo";
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    lastPreview = el;
  };

  // Tab completion is computed viewer-side; the terminal only remembers what
  // it asked for, applies the returned extension if the input is unchanged
  // (stale replies drop), and prints ambiguous candidate lists shell-style.
  let pendingComplete: { id: number; text: string; cursor: number } | null = null;

  window.addEventListener("message", (e: MessageEvent) => {
    const claudeEvent = parseClaudeEvent(e.data);
    if (claudeEvent) {
      claudePanel.handleEvent(claudeEvent);
      // A typed result rides the same event; the transcript printed the
      // summary above — the BINDING is a separate consumer, executed
      // viewer-side where the rails live. Forward the RAW payload (the
      // viewer's dispatch is the validation gate, so malformed/unknown
      // kinds come back as binding errors, never guesses).
      if (claudeEvent.type === "tool-result") {
        const raw = (e.data as { result?: unknown }).result;
        if (raw !== undefined) {
          host.postMessage({ type: "claude-bind", callId: claudeEvent.callId, result: raw });
        }
      }
      return;
    }
    const bindMsg = e.data as
      | { type?: string; callId?: string; ok?: boolean; message?: string }
      | undefined;
    if (bindMsg?.type === "claude-bind-result") {
      claudePanel.setBindOutcome(String(bindMsg.callId ?? ""), {
        ok: bindMsg.ok === true,
        message: String(bindMsg.message ?? ""),
      });
      return;
    }
    const m = e.data as CommandResultMsg | CompleteResultMsg | undefined;
    if (m?.type === "commandResult") {
      print(m.status === "error" ? "term-err" : m.status === "nomatch" ? "term-nomatch" : "term-ok", m.message);
      return;
    }
    if (m?.type === "completeResult") {
      const req = pendingComplete;
      pendingComplete = null;
      if (!req || m.id !== req.id || input.value !== req.text) return; // stale
      if (m.applied) {
        input.value = req.text.slice(0, req.cursor) + m.applied + req.text.slice(req.cursor);
        const caret = req.cursor + m.applied.length;
        input.setSelectionRange(caret, caret);
      }
      if (m.candidates.length > 1) {
        // "@name." completions are FILTER vocabulary (predicates over the
        // points' type or ancestor labels), not a membership listing — the
        // header keeps that unmistakable. Path completions are genuine tree
        // levels and stay headerless.
        const body = m.candidates.join("  ");
        printCompletionPreview(
          m.kind === "filter" ? `filter by (type or label):\n${body}` : body,
        );
      }
    }
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
      if (text === "clear") {
        // Terminal-local: wipes this log only — never reaches viewer state,
        // creates no undo step. (The panel's "Clear" button is a different
        // operation: it discards the pending target.)
        log.replaceChildren();
        lastPreview = null;
        input.value = "";
        return;
      }
      if (text === "/claude") {
        // Terminal-local, like `clear`: toggles the conversation panel above
        // this terminal (open focuses its input; close restores full height).
        // Registered in the command registry only so `help /claude` explains
        // it — viewer state never hears about the toggle.
        claudePanel.toggle();
        input.value = "";
        return;
      }
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
    } else if (e.key === "Tab") {
      e.preventDefault(); // keep focus in the input
      const req = {
        id: nextId++,
        text: input.value,
        cursor: input.selectionStart ?? input.value.length,
      };
      pendingComplete = req;
      host.postMessage({ type: "complete", id: req.id, text: req.text, cursor: req.cursor });
    }
  });

  input.focus();

  // Lifecycle glue (transport-level, NOT part of the frozen panel↔backend
  // contract): tell the host this page's listeners are live. The host
  // creates the backend (stub) on this signal, so its opening auth-status
  // can never be posted into a page that isn't listening yet.
  host.postMessage({ type: "claude-ready" });
}

main();
