/**
 * Shared HUD template — the webview's DOM skeleton and layout CSS, used by BOTH
 * hosts (the VS Code extension in src/extension.ts and the headless test harness
 * in tests/bridge.ts) so the two never drift. Structure only — no beautification.
 *
 * Layout is a non-overlapping vertical stack: a top bar (dataset header), a
 * middle row (the classification panel + a drag divider + the canvas), and a
 * bottom control bar. The classification panel is DOCKABLE (left/right/top/
 * bottom) and COLLAPSIBLE (Increment 4.6.1): `#root[data-dock=…]` flips the
 * middle row between row/column (and reversed) so the panel sits on the chosen
 * edge; a `.panel-collapsed` root hides it behind a "show panel" button. When
 * docked top/bottom the tree lays its categories out horizontally and scrolls
 * left/right (better use of a short, wide strip). The divider resizes the panel
 * (width when side-docked, height when top/bottom-docked). Nothing floats over
 * the canvas except the single bulk-visibility toggle, in a reserved corner.
 */

export const HUD_CSS = /* css */ `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: #1e1e1e; color: #cccccc; font: 12px monospace; }
  * { box-sizing: border-box; }
  #root { position: absolute; inset: 0; display: flex; flex-direction: column; }

  /* reserved top bar: dataset header (+ a show-panel button when collapsed) */
  #topbar { flex: none; height: 26px; display: flex; align-items: center; gap: 12px;
    padding: 0 10px; background: #1e1e1e; border-bottom: 1px solid #3a3a3a; }
  #status { flex: 1 1 auto; min-width: 0; color: #9a9a9a;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #panel-show { flex: none; display: none; padding: 1px 8px; font: inherit; color: inherit;
    background: #3a3a3a; border: 1px solid #555; border-radius: 3px; cursor: pointer; }
  #root.panel-collapsed #panel-show { display: inline-block; }

  /* middle row: panel | divider | canvas — direction set by the dock */
  #middle { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; }
  #root[data-dock="left"]   #middle { flex-direction: row; }
  #root[data-dock="right"]  #middle { flex-direction: row-reverse; }
  #root[data-dock="top"]    #middle { flex-direction: column; }
  #root[data-dock="bottom"] #middle { flex-direction: column-reverse; }

  #sidebar { flex: none; display: flex; flex-direction: column; overflow: hidden;
    background: #252526; }
  #root[data-dock="left"] #sidebar, #root[data-dock="right"] #sidebar { width: 300px; }
  #root[data-dock="top"] #sidebar, #root[data-dock="bottom"] #sidebar { height: 200px; }
  #sidebar-content { flex: 1 1 auto; overflow: auto; padding: 8px; user-select: none; }

  #dock-toolbar { flex: none; display: flex; align-items: center; gap: 2px;
    padding: 3px 6px; border-bottom: 1px solid #3a3a3a; }
  #dock-toolbar button { width: 22px; height: 20px; padding: 0; font: inherit; line-height: 1;
    color: #ccc; background: #3a3a3a; border: 1px solid #555; border-radius: 3px; cursor: pointer; }
  #dock-toolbar button.active { background: #10493f; color: #7fffe6; border-color: #10493f; }
  #panel-collapse { margin-left: auto; }

  #divider { flex: none; background: #3a3a3a; }
  #divider:hover { background: #505050; }
  #root[data-dock="left"] #divider, #root[data-dock="right"] #divider { width: 6px; cursor: col-resize; }
  #root[data-dock="top"] #divider, #root[data-dock="bottom"] #divider { height: 6px; cursor: row-resize; }

  #app { flex: 1 1 auto; min-width: 0; min-height: 0; position: relative; overflow: hidden; }
  #app canvas { display: block; }

  /* collapsed: hide the panel and its divider; canvas takes the whole middle */
  #root.panel-collapsed #sidebar, #root.panel-collapsed #divider { display: none; }

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

  /* top/bottom dock: lay categories out horizontally, scroll left/right */
  #root[data-dock="top"] #sidebar-content, #root[data-dock="bottom"] #sidebar-content {
    overflow-x: auto; overflow-y: hidden; }
  #root[data-dock="top"] .tree, #root[data-dock="bottom"] .tree {
    display: flex; flex-direction: row; align-items: flex-start; gap: 18px; }
  #root[data-dock="top"] .cat-block, #root[data-dock="bottom"] .cat-block { min-width: max-content; }
`;

export const HUD_BODY = /* html */ `
  <div id="root" data-dock="left">
    <div id="topbar">
      <span id="status">loading…</span>
      <button id="panel-show" title="Show panel">▤ panel</button>
    </div>
    <div id="middle">
      <div id="sidebar">
        <div id="dock-toolbar">
          <button data-dock-to="top" title="Dock to top">⤒</button>
          <button data-dock-to="left" title="Dock to left">⇤</button>
          <button data-dock-to="right" title="Dock to right">⇥</button>
          <button data-dock-to="bottom" title="Dock to bottom">⤓</button>
          <button id="panel-collapse" title="Collapse panel">✕</button>
        </div>
        <div id="sidebar-content"></div>
      </div>
      <div id="divider" title="drag to resize the panel"></div>
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
