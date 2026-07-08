/**
 * Shared HUD template — the webview's DOM skeleton and layout CSS, used by BOTH
 * hosts (the VS Code extension in src/extension.ts and the headless test harness
 * in tests/bridge.ts) so the two never drift. Structure only — no beautification.
 *
 * Layout is a non-overlapping vertical stack of RESERVED regions (Increment 4.5,
 * item B): a top bar (dataset header + selection readout, separate flex cells),
 * a middle row (resizable sidebar | drag divider | canvas), and a bottom control
 * bar. Nothing floats over the canvas except the single bulk-visibility toggle,
 * which sits in a reserved, z-ordered corner. Each host wraps HUD_CSS in a
 * nonce'd <style> and injects HUD_BODY into <body>, then adds its own scripts.
 */

export const HUD_CSS = /* css */ `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: #1e1e1e; color: #cccccc; font: 12px monospace; }
  * { box-sizing: border-box; }
  #root { position: absolute; inset: 0; display: flex; flex-direction: column; }

  /* reserved top bar: header (left) + selection readout (right), never overlap */
  #topbar { flex: none; height: 26px; display: flex; align-items: center; gap: 16px;
    padding: 0 10px; background: #1e1e1e; border-bottom: 1px solid #3a3a3a; }
  #status { flex: 1 1 auto; min-width: 0; color: #9a9a9a;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #selreadout { flex: 0 1 auto; min-width: 0; color: #33ffcc; text-align: right;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* middle row: sidebar | divider | canvas */
  #middle { flex: 1 1 auto; min-height: 0; display: flex; }
  #sidebar { flex: none; width: 300px; overflow-y: auto; overflow-x: hidden;
    background: #252526; padding: 8px; user-select: none; }
  #divider { flex: none; width: 6px; cursor: col-resize; background: #3a3a3a; }
  #divider:hover { background: #505050; }
  #app { flex: 1 1 auto; min-width: 0; position: relative; overflow: hidden; }
  #app canvas { display: block; }

  /* the one representation control, in a reserved, unobstructed corner */
  #bulk-toggle { position: absolute; top: 8px; right: 8px; z-index: 5;
    padding: 4px 8px; font: inherit; color: inherit; background: #3a3a3a;
    border: 1px solid #555; border-radius: 3px; cursor: pointer; }

  /* reserved bottom control bar */
  #controls { flex: none; height: 40px; display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; background: #252526; border-top: 1px solid #3a3a3a; }
  #controls button { width: 60px; padding: 3px 0; font: inherit; color: inherit;
    background: #3a3a3a; border: 1px solid #555; border-radius: 3px; cursor: pointer; }
  #controls input[type="range"] { flex: 1; }
  #controls .readout { min-width: 240px; text-align: right; white-space: pre; }

  /* classification tree */
  .sel-readout { color: #33ffcc; padding: 2px 4px 6px; white-space: normal; }
  .sidebar-hint { color: #7a7a7a; padding: 0 4px 8px; border-bottom: 1px solid #3a3a3a; margin-bottom: 6px; }
  .tree-row { display: flex; align-items: baseline; gap: 4px; padding: 2px 4px;
    border-radius: 3px; white-space: nowrap; }
  .tree-row.selectable { cursor: pointer; }
  .tree-row.selectable:hover { background: #2f3a42; }
  .tree-row.active { background: #10493f; color: #7fffe6; }
  .tree-row.muted .tree-label { color: #9a9a9a; }
  .caret { width: 10px; display: inline-block; color: #888; cursor: pointer; }
  .tree-label { overflow: hidden; text-overflow: ellipsis; }
`;

export const HUD_BODY = /* html */ `
  <div id="root">
    <div id="topbar">
      <span id="status">loading…</span>
      <span id="selreadout"></span>
    </div>
    <div id="middle">
      <div id="sidebar"></div>
      <div id="divider" title="drag to resize sidebar"></div>
      <div id="app">
        <button id="bulk-toggle">show bulk</button>
      </div>
    </div>
    <div id="controls">
      <button id="playpause" disabled>play</button>
      <input id="scrubber" type="range" min="0" max="0" value="0" step="1" disabled>
      <span id="readout" class="readout"></span>
    </div>
  </div>
`;
