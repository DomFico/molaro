/**
 * Terminal panel skeleton — DOM + CSS for the command terminal webview, shared
 * by BOTH hosts (src/extension.ts renders the real panel; tests/bridge.ts
 * serves the smoke-test harness) so the two never drift — the same rule as
 * hud.ts for the viewer panel. Styling follows the viewer's dark palette but
 * is its own minimal sheet (hud.ts is not forked).
 */

export const TERMINAL_CSS = /* css */ `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: #1e1e1e; color: #cccccc; font: 12px monospace; }
  * { box-sizing: border-box; }
  #term-root { position: absolute; inset: 0; z-index: 100; display: flex;
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
`;

export const TERMINAL_BODY = /* html */ `
  <div id="term-root">
    <div id="term-log"></div>
    <div id="term-inputrow">
      <span id="term-prompt">›</span>
      <input id="term-input" type="text" spellcheck="false" autocomplete="off"
             placeholder="command…">
    </div>
  </div>
`;
