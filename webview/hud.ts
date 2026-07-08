/**
 * Shared HUD template — the webview's DOM skeleton and layout CSS, used by BOTH
 * hosts (the VS Code extension in src/extension.ts and the headless test harness
 * in tests/bridge.ts) so the two never drift. Structure only — no beautification.
 *
 * Layout: a top bar (dataset header), a middle row (classification panel + drag
 * divider + canvas), and a bottom control bar. The panel is DOCKABLE by DRAGGING
 * its grip onto an edge drop-zone (left/right/top/bottom), resizable via the
 * divider, and COLLAPSIBLE (collapsing leaves a reopen tab at the panel's last
 * dock edge). Docked top/bottom, the tree flows its categories horizontally and
 * scrolls left/right. The panel holds the active-sets surface (#active-sets) over
 * the tree (#tree-host). Default dock is the right edge.
 */

export const HUD_CSS = /* css */ `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: #1e1e1e; color: #cccccc; font: 12px monospace; }
  * { box-sizing: border-box; }
  #root { position: absolute; inset: 0; display: flex; flex-direction: column; }

  #topbar { flex: none; height: 26px; display: flex; align-items: center; gap: 12px;
    padding: 0 10px; background: #1e1e1e; border-bottom: 1px solid #3a3a3a; }
  #status { flex: 1 1 auto; min-width: 0; color: #9a9a9a;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  #middle { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; }
  #root[data-dock="left"]   #middle { flex-direction: row; }
  #root[data-dock="right"]  #middle { flex-direction: row-reverse; }
  #root[data-dock="top"]    #middle { flex-direction: column; }
  #root[data-dock="bottom"] #middle { flex-direction: column-reverse; }

  #sidebar { flex: none; display: flex; flex-direction: column; overflow: hidden;
    background: #252526; }
  #root[data-dock="left"] #sidebar, #root[data-dock="right"] #sidebar { width: 300px; }
  #root[data-dock="top"] #sidebar, #root[data-dock="bottom"] #sidebar { height: 220px; }
  #sidebar-content { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px; user-select: none; }

  #dock-toolbar { flex: none; display: flex; align-items: center; gap: 6px;
    padding: 3px 6px; border-bottom: 1px solid #3a3a3a; }
  #panel-grip { flex: 1 1 auto; cursor: grab; color: #9a9a9a; user-select: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #panel-grip:active { cursor: grabbing; }
  #dock-toolbar button { flex: none; width: 22px; height: 20px; padding: 0; font: inherit; line-height: 1;
    color: #ccc; background: #3a3a3a; border: 1px solid #555; border-radius: 3px; cursor: pointer; }

  #divider { flex: none; background: #3a3a3a; }
  #divider:hover { background: #505050; }
  #root[data-dock="left"] #divider, #root[data-dock="right"] #divider { width: 6px; cursor: col-resize; }
  #root[data-dock="top"] #divider, #root[data-dock="bottom"] #divider { height: 6px; cursor: row-resize; }

  #app { flex: 1 1 auto; min-width: 0; min-height: 0; position: relative; overflow: hidden; }
  #app canvas { display: block; }

  /* collapsed: hide the panel + divider; a reopen tab sits at the last dock edge */
  #root.panel-collapsed #sidebar, #root.panel-collapsed #divider { display: none; }
  #panel-reopen { display: none; position: absolute; z-index: 20; padding: 3px 7px;
    font: inherit; color: #ccc; background: #3a3a3a; border: 1px solid #555; cursor: pointer; }
  #root.panel-collapsed #panel-reopen { display: block; }
  #root.panel-collapsed[data-dock="right"]  #panel-reopen { right: 0; top: 50%; transform: translateY(-50%); border-radius: 3px 0 0 3px; }
  #root.panel-collapsed[data-dock="left"]   #panel-reopen { left: 0; top: 50%; transform: translateY(-50%); border-radius: 0 3px 3px 0; }
  #root.panel-collapsed[data-dock="top"]    #panel-reopen { top: 26px; left: 50%; transform: translateX(-50%); border-radius: 0 0 3px 3px; }
  #root.panel-collapsed[data-dock="bottom"] #panel-reopen { bottom: 40px; left: 50%; transform: translateX(-50%); border-radius: 3px 3px 0 0; }

  /* drag-to-dock overlay: a soft translucent fill on the target dock region
     (no hard outline) — only the nearest-edge zone shows while dragging (A2). */
  #dock-overlay { display: none; position: absolute; inset: 0; z-index: 50; pointer-events: none; }
  #dock-overlay.active { display: block; }
  .dock-zone { position: absolute; background: transparent; border-radius: 6px;
    transition: background 90ms ease; }
  .dock-zone.hot { background: rgba(120,180,225,0.16); box-shadow: inset 0 0 0 1px rgba(150,200,235,0.28); }
  .dock-zone[data-zone="top"]    { top: 0; left: 0; right: 0; height: 30%; }
  .dock-zone[data-zone="bottom"] { bottom: 0; left: 0; right: 0; height: 30%; }
  .dock-zone[data-zone="left"]   { left: 0; top: 0; bottom: 0; width: 28%; }
  .dock-zone[data-zone="right"]  { right: 0; top: 0; bottom: 0; width: 28%; }

  /* reserved bottom control bar */
  #controls { flex: none; height: 40px; display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; background: #252526; border-top: 1px solid #3a3a3a; }
  #controls button { width: 60px; padding: 3px 0; font: inherit; color: inherit;
    background: #3a3a3a; border: 1px solid #555; border-radius: 3px; cursor: pointer; }
  #controls input[type="range"] { flex: 1; }
  #controls .readout { min-width: 240px; text-align: right; white-space: pre; }

  /* active-sets surface (Selections / Hidden) */
  #active-sets { border-bottom: 1px solid #3a3a3a; margin-bottom: 6px; padding-bottom: 4px; }
  .set-section { margin: 2px 0; }
  .set-head { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 2px 4px; }
  .set-head .set-caret { width: 10px; color: #888; }
  .set-title { flex: 1 1 auto; }
  .set-title.sel { color: #33ffcc; }
  .set-title.hid { color: #d0a0ff; }
  .set-mini-btn { font: inherit; color: #ccc; background: #3a3a3a; border: 1px solid #555;
    border-radius: 3px; cursor: pointer; padding: 0 6px; }
  .set-entries { display: none; }
  .set-section.open .set-entries { display: block; }
  .sel-group { margin: 2px 0 4px; }
  .sel-group.active > .sel-group-head { color: #7fffe6; }
  .sel-group-head { display: flex; align-items: center; gap: 5px; padding: 1px 4px; }
  .sel-dot { width: 10px; color: #33ffcc; }
  .sel-group-name { flex: 1 1 auto; cursor: pointer; overflow: hidden; text-overflow: ellipsis; }
  .entry-tree { }
  .entry-row { display: flex; align-items: center; gap: 6px; padding: 1px 4px; white-space: nowrap; }
  .entry-row.structural { color: #8a8a8a; }
  .entry-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .entry-remove { cursor: pointer; color: #888; }
  .entry-remove:hover { color: #fff; }

  /* classification tree (fixed-height rows so long lists can virtualize) */
  .sidebar-hint { color: #7a7a7a; padding: 0 4px 8px; }
  .vlist { position: relative; }
  .tree-row { display: flex; align-items: center; gap: 4px; height: 18px; padding: 0 4px;
    border-radius: 3px; white-space: nowrap; }
  .tree-row.selectable { cursor: pointer; }
  .tree-row.selectable:hover { background: #2f3a42; }
  .tree-row.selected { background: #10493f; color: #7fffe6; }
  .tree-row.hidden-entry .tree-label { color: #b98be0; text-decoration: line-through; }
  .caret { width: 10px; display: inline-block; color: #888; cursor: pointer; }
  .tree-label { overflow: hidden; text-overflow: ellipsis; }

  /* top/bottom dock: the whole content flows LEFT-TO-RIGHT (A3). #sidebar-content
     becomes a row: active-sets is a fixed left column, the tree host takes the
     rest and scrolls horizontally with its categories laid out as columns. */
  #root[data-dock="top"] #sidebar-content, #root[data-dock="bottom"] #sidebar-content {
    display: flex; flex-direction: row; align-items: stretch; gap: 12px;
    overflow-x: auto; overflow-y: hidden; }
  #root[data-dock="top"] #active-sets, #root[data-dock="bottom"] #active-sets {
    flex: none; width: 240px; overflow-y: auto; border-bottom: none;
    border-right: 1px solid #3a3a3a; margin-bottom: 0; padding-right: 8px; }
  #root[data-dock="top"] #tree-host, #root[data-dock="bottom"] #tree-host {
    flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; }
  #root[data-dock="top"] .sidebar-hint, #root[data-dock="bottom"] .sidebar-hint { display: none; }
  #root[data-dock="top"] .tree, #root[data-dock="bottom"] .tree {
    display: flex; flex-direction: row; align-items: flex-start; gap: 18px; height: 100%; }
  #root[data-dock="top"] .cat-block, #root[data-dock="bottom"] .cat-block {
    min-width: max-content; overflow-y: auto; max-height: 100%; }
`;

export const HUD_BODY = /* html */ `
  <div id="root" data-dock="right">
    <div id="topbar">
      <span id="status">loading…</span>
    </div>
    <div id="middle">
      <div id="sidebar">
        <div id="dock-toolbar">
          <span id="panel-grip" title="Drag to dock (left / right / top / bottom)">⠿ panel</span>
          <button id="panel-collapse" title="Collapse panel">▾</button>
        </div>
        <div id="sidebar-content">
          <div id="active-sets"></div>
          <div id="tree-host"></div>
        </div>
      </div>
      <div id="divider" title="drag to resize the panel"></div>
      <div id="app"></div>
    </div>
    <div id="controls">
      <button id="playpause" disabled>play</button>
      <input id="scrubber" type="range" min="0" max="0" value="0" step="1" disabled>
      <span id="readout" class="readout"></span>
    </div>
    <button id="panel-reopen" title="Show panel">▤ panel</button>
    <div id="dock-overlay">
      <div class="dock-zone" data-zone="top"></div>
      <div class="dock-zone" data-zone="left"></div>
      <div class="dock-zone" data-zone="right"></div>
      <div class="dock-zone" data-zone="bottom"></div>
    </div>
  </div>
`;
