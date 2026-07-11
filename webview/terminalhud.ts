/**
 * Terminal panel skeleton — DOM + CSS for the command terminal webview, shared
 * by BOTH hosts (src/extension.ts renders the real panel; tests/bridge.ts
 * serves the smoke-test harness) so the two never drift — the same rule as
 * hud.ts for the viewer panel. Styling follows the viewer's dark palette but
 * is its own minimal sheet (hud.ts is not forked).
 *
 * The page is a flex column of two regions: the conversation panel
 * (#claude-root, hidden until `/claude` opens it — a fixed 60/40 split) above
 * the terminal (#term-root). Collapsing the panel gives the terminal the full
 * height back. The panel's DOM is populated by claudepanel.ts; only the
 * skeleton and styling live here.
 */

export const TERMINAL_CSS = /* css */ `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: #1e1e1e; color: #cccccc; font: 12px monospace; }
  * { box-sizing: border-box; }
  /* The stack fills the window (and, in the smoke harness, overlays the
     viewer exactly as #term-root alone used to): conversation panel above,
     terminal below, a fixed 60/40 split while the panel is open. */
  #term-stack { position: absolute; inset: 0; z-index: 100; display: flex;
    flex-direction: column; background: #1e1e1e; }
  #term-root { flex: 1 1 0; min-height: 0; display: flex;
    flex-direction: column; background: #1e1e1e; }
  #term-log { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 10px; }
  .term-line { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .term-echo { color: #9a9a9a; }
  .term-ok { color: #bfffe4; }
  .term-nomatch { color: #8a8a8a; }
  .term-err { color: #e8a9a9; }
  #term-inputrow { flex: none; display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-top: 1px solid #3a3a3a; background: #252526; }
  #term-prompt { flex: none; color: #9fe8cd; }
  #term-input { flex: 1 1 auto; font: inherit; color: #eee; background: #1e1e1e;
    border: 1px solid #3a3a3a; border-radius: 3px; padding: 3px 6px; outline: none; }
  #term-input:focus { border-color: #5cb99a; }

  /* -- conversation panel (/claude) ------------------------------------- */
  #claude-root { flex: 3 1 0; min-height: 0; display: flex; flex-direction: column;
    background: #1b1b1c; border-bottom: 2px solid #3a3a3a; }
  #claude-root.collapsed { display: none; }
  #claude-root:not(.collapsed) ~ #term-root { flex: 2 1 0; }
  #claude-status { flex: none; display: flex; align-items: center; gap: 6px;
    padding: 4px 10px; background: #252526; border-bottom: 1px solid #3a3a3a;
    color: #9a9a9a; }
  #claude-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
  #claude-dot.connected { background: #5cb99a; }
  #claude-dot.disconnected { background: #b96a5c; }
  #claude-status-text { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  #claude-close { flex: none; font: inherit; color: #9a9a9a; background: none;
    border: none; cursor: pointer; padding: 0 2px; }
  #claude-close:hover { color: #eee; }
  #claude-transcript { flex: 1 1 auto; min-height: 0; overflow-y: auto;
    padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .cl-user { color: #dcdcaa; white-space: pre-wrap; word-break: break-word; }
  .cl-user::before { content: "you › "; color: #9a9a9a; }
  .cl-assistant { color: #cccccc; white-space: pre-wrap; word-break: break-word; }
  .cl-tool { border: 1px solid #3a3a3a; border-left: 3px solid #5a7a9a;
    border-radius: 3px; padding: 4px 8px; background: #232324; }
  .cl-tool-head { color: #9fbde8; }
  .cl-tool-args { color: #8a8a8a; }
  .cl-approval { margin-top: 4px; display: flex; align-items: center; gap: 8px;
    color: #dcb96a; }
  .cl-approve, .cl-deny { font: inherit; padding: 1px 8px; border-radius: 3px;
    border: 1px solid #3a3a3a; background: #2d2d2e; color: #ccc; cursor: pointer; }
  .cl-approve:hover:not(:disabled) { border-color: #5cb99a; color: #bfffe4; }
  .cl-deny:hover:not(:disabled) { border-color: #b96a5c; color: #e8a9a9; }
  .cl-approve:disabled, .cl-deny:disabled { opacity: 0.45; cursor: default; }
  .cl-result { margin-top: 4px; }
  .cl-result.ok { color: #bfffe4; }
  .cl-result.err { color: #e8a9a9; }
  .cl-bind { margin-top: 2px; font-style: italic; }
  .cl-bind.ok { color: #9fbde8; }
  .cl-bind.err { color: #e8a9a9; }
  .cl-error { color: #e8a9a9; border: 1px solid #6a3a3a; border-radius: 3px;
    padding: 4px 8px; background: #2a2022; white-space: pre-wrap; }
  #claude-inputrow { flex: none; display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-top: 1px solid #3a3a3a; background: #252526; }
  #claude-input { flex: 1 1 auto; font: inherit; color: #eee; background: #1e1e1e;
    border: 1px solid #3a3a3a; border-radius: 3px; padding: 3px 6px; outline: none; }
  #claude-input:focus { border-color: #5cb99a; }
  #claude-input:disabled { opacity: 0.55; }
  #claude-cancel { flex: none; font: inherit; padding: 2px 8px; border-radius: 3px;
    border: 1px solid #3a3a3a; background: #2d2d2e; color: #ccc; cursor: pointer; }
  #claude-cancel:hover { border-color: #b96a5c; color: #e8a9a9; }
  #claude-cancel[hidden] { display: none; }
`;

export const TERMINAL_BODY = /* html */ `
  <div id="term-stack">
    <div id="claude-root" class="collapsed">
      <div id="claude-status">
        <span id="claude-dot"></span>
        <span id="claude-status-text">no backend status yet</span>
        <button id="claude-close" title="close (/claude)">✕</button>
      </div>
      <div id="claude-transcript"></div>
      <div id="claude-inputrow">
        <input id="claude-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="message…">
        <button id="claude-cancel" hidden>stop</button>
      </div>
    </div>
    <div id="term-root">
      <div id="term-log"></div>
      <div id="term-inputrow">
        <span id="term-prompt">›</span>
        <input id="term-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="command…">
      </div>
    </div>
  </div>
`;
