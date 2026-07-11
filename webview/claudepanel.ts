/**
 * The conversation panel — a renderer over the transcript reducer
 * (claudemodel.ts) mounted in the terminal webview above the terminal
 * (`/claude` toggles it; terminalhud.ts owns the skeleton/CSS). The panel is
 * DUMB about the backend: it sends the frozen ClaudeCommand set through the
 * injected `send` and renders the ClaudeEvent stream fed to `handleEvent` —
 * whoever is behind the relay (the scripted stub today, the real assistant
 * later) is invisible from here.
 *
 * The transcript re-renders from state on every event (small scale, no
 * virtualization needed); approve/deny disabled-ness derives from state
 * (markDecision), so re-renders can't resurrect clicked buttons. The
 * auth-status line is display-only.
 */
import {
  addUserMessage,
  applyEvent,
  createTranscript,
  markDecision,
  setBindOutcome,
  type ClaudeCommand,
  type ClaudeEvent,
  type TranscriptItem,
} from "./claudemodel.ts";

export interface ClaudePanel {
  toggle(): void;
  isOpen(): boolean;
  handleEvent(ev: ClaudeEvent): void;
  /** The viewer's claude-bind-result reply for a call's typed result —
   * renders as the tool block's binding line. */
  setBindOutcome(callId: string, outcome: { ok: boolean; message: string }): void;
}

export function mountClaudePanel(send: (cmd: ClaudeCommand) => void): ClaudePanel {
  const root = document.getElementById("claude-root");
  const statusDot = document.getElementById("claude-dot");
  const statusText = document.getElementById("claude-status-text");
  const closeBtn = document.getElementById("claude-close");
  const transcript = document.getElementById("claude-transcript");
  const input = document.getElementById("claude-input") as HTMLInputElement | null;
  const cancelBtn = document.getElementById("claude-cancel") as HTMLButtonElement | null;
  if (!root || !statusDot || !statusText || !closeBtn || !transcript || !input || !cancelBtn) {
    throw new Error("claude panel: skeleton elements missing");
  }

  const state = createTranscript();

  const itemEl = (item: TranscriptItem): HTMLElement => {
    if (item.kind === "user") {
      const el = document.createElement("div");
      el.className = "cl-user";
      el.textContent = item.text;
      return el;
    }
    if (item.kind === "error") {
      const el = document.createElement("div");
      el.className = "cl-error";
      el.textContent = item.message;
      return el;
    }
    // assistant turn: its text, then its tool blocks
    const wrap = document.createElement("div");
    wrap.className = "cl-turn";
    if (item.text) {
      const txt = document.createElement("div");
      txt.className = "cl-assistant";
      txt.textContent = item.text;
      wrap.appendChild(txt);
    }
    for (const block of item.blocks) {
      const b = document.createElement("div");
      b.className = "cl-tool";
      b.dataset.callId = block.callId;
      const head = document.createElement("div");
      head.className = "cl-tool-head";
      head.textContent = block.toolName;
      const args = document.createElement("div");
      args.className = "cl-tool-args";
      args.textContent = block.argsPreview;
      b.append(head, args);
      if (block.approval) {
        const row = document.createElement("div");
        row.className = "cl-approval";
        const label = document.createElement("span");
        label.textContent = block.approval.preview;
        const approve = document.createElement("button");
        approve.className = "cl-approve";
        approve.textContent = "approve";
        const deny = document.createElement("button");
        deny.className = "cl-deny";
        deny.textContent = "deny";
        const decided = block.approval.decision !== null;
        approve.disabled = decided;
        deny.disabled = decided;
        const decide = (decision: "approve" | "deny") => (): void => {
          if (block.approval?.decision !== null) return; // already decided
          markDecision(state, block.callId, decision);
          send({ type: "approval-decision", callId: block.callId, decision });
          render();
        };
        approve.addEventListener("click", decide("approve"));
        deny.addEventListener("click", decide("deny"));
        row.append(label, approve, deny);
        b.appendChild(row);
      }
      if (block.result) {
        const res = document.createElement("div");
        res.className = `cl-result ${block.result.ok ? "ok" : "err"}`;
        res.textContent = block.result.summary;
        b.appendChild(res);
      }
      if (block.bind) {
        const bind = document.createElement("div");
        bind.className = `cl-bind ${block.bind.ok ? "ok" : "err"}`;
        bind.textContent = `⤷ ${block.bind.message}`;
        b.appendChild(bind);
      }
      wrap.appendChild(b);
    }
    return wrap;
  };

  const render = (): void => {
    transcript.replaceChildren(...state.items.map(itemEl));
    transcript.scrollTop = transcript.scrollHeight;
    input.disabled = state.busy;
    cancelBtn.hidden = !state.busy;
    if (state.auth) {
      statusDot.className = state.auth.state;
      statusText.textContent =
        state.auth.hint ? `${state.auth.state} — ${state.auth.hint}` : state.auth.state;
    }
  };

  const open = (): void => {
    root.classList.remove("collapsed");
    render();
    input.focus();
  };
  const close = (): void => {
    root.classList.add("collapsed");
    document.getElementById("term-input")?.focus();
  };

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const text = input.value.trim();
    if (!text || state.busy) return;
    addUserMessage(state, text);
    send({ type: "user-message", text });
    input.value = "";
    render();
  });
  cancelBtn.addEventListener("click", () => {
    if (state.busy) send({ type: "cancel" });
  });
  closeBtn.addEventListener("click", close);

  return {
    toggle(): void {
      if (root.classList.contains("collapsed")) open();
      else close();
    },
    isOpen(): boolean {
      return !root.classList.contains("collapsed");
    },
    handleEvent(ev: ClaudeEvent): void {
      applyEvent(state, ev);
      render();
    },
    setBindOutcome(callId: string, outcome: { ok: boolean; message: string }): void {
      setBindOutcome(state, callId, outcome);
      render();
    },
  };
}
