/**
 * Shared HUD template — the webview's DOM skeleton and layout CSS, used by BOTH
 * hosts (the VS Code extension in src/extension.ts and the headless test harness
 * in tests/bridge.ts) so the two never drift.
 *
 * Layout: a top bar (dataset header), a middle row (panel + drag divider +
 * canvas), and a bottom control bar. The panel is DOCKABLE by DRAGGING its grip
 * onto an edge drop-zone (left/right/top/bottom), resizable via the divider,
 * and COLLAPSIBLE (collapsing leaves a reopen tab at the panel's last dock
 * edge). Docked top/bottom, the content flows horizontally.
 *
 * The panel holds TWO sections built from ONE tree component:
 *   - #selections (top): the committed selections — the "operate" surface
 *   - #tree-host (bottom): the full classification tree — the "build" surface,
 *     with the bracket overlay (pending green + committed neutral/purple)
 * The viewer corner carries the commit button (#commit-btn,
 * "Create selection" / "Done").
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

  /* viewer-corner actions: Clear (two-step confirm) + Create selection / Done */
  #viewer-actions { position: absolute; top: 10px; right: 10px; z-index: 15;
    display: flex; gap: 6px; }
  #viewer-actions button { padding: 5px 12px; font: inherit; font-weight: bold;
    letter-spacing: 0.2px; border-radius: 4px; cursor: pointer; }
  #commit-btn { color: #0b3529; background: #9fe8cd; border: 1px solid #5cb99a; }
  #commit-btn:hover:not(:disabled) { background: #b8f2dd; }
  #commit-btn:disabled { background: #2e3a37; color: #71817c; border-color: #47524e;
    cursor: default; }
  #commit-btn.editing { background: #f2dc9b; border-color: #bfa35c; color: #3a2f10; }
  #clear-btn { color: #ccc; background: #3a3a3a; border: 1px solid #555; }
  #clear-btn:hover:not(:disabled) { background: #4a4a4a; }
  #clear-btn:disabled { color: #71817c; border-color: #47524e; cursor: default; }
  #clear-btn.confirm { color: #3a1010; background: #e8a9a9; border-color: #b96c6c; }

  /* collapsed: hide the panel + divider; a reopen tab sits at the last dock edge */
  #root.panel-collapsed #sidebar, #root.panel-collapsed #divider { display: none; }
  #panel-reopen { display: none; position: absolute; z-index: 20; padding: 3px 7px;
    font: inherit; color: #ccc; background: #3a3a3a; border: 1px solid #555; cursor: pointer; }
  #root.panel-collapsed #panel-reopen { display: block; }
  #root.panel-collapsed[data-dock="right"]  #panel-reopen { right: 0; top: 50%; transform: translateY(-50%); border-radius: 3px 0 0 3px; }
  #root.panel-collapsed[data-dock="left"]   #panel-reopen { left: 0; top: 50%; transform: translateY(-50%); border-radius: 0 3px 3px 0; }
  #root.panel-collapsed[data-dock="top"]    #panel-reopen { top: 26px; left: 50%; transform: translateX(-50%); border-radius: 0 0 3px 3px; }
  #root.panel-collapsed[data-dock="bottom"] #panel-reopen { bottom: 40px; left: 50%; transform: translateX(-50%); border-radius: 3px 3px 0 0; }

  /* drag-to-dock overlay: a soft translucent fill on the target dock region */
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

  /* ---- top section: committed selections (operate) ------------------------- */
  #selections { border-bottom: 1px solid #3a3a3a; margin-bottom: 6px; padding-bottom: 4px; }
  .sel-section-head { color: #9a9a9a; padding: 2px 4px 6px; }
  .sel-empty { color: #6a6a6a; padding: 0 4px 6px; font-style: italic; }
  .sel-block { margin: 2px 0 5px; border-left: 2px solid #5a5a5a; padding-left: 3px; }
  .sel-block.hidden-sel { border-left-color: #b98be0; }
  .sel-block.editing { border-left-color: #9fe8cd; background: rgba(159,232,205,0.06); }
  .sel-head { display: flex; align-items: center; gap: 6px; padding: 1px 4px;
    position: relative; border-radius: 3px; transition: background-color 320ms ease; }
  .sel-name { flex: 1 1 auto; min-width: 0; cursor: pointer;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hidden-sel .sel-name { color: #c9a6ec; }
  .sel-count { color: #8a8a8a; white-space: nowrap; }
  .sel-ctl { flex: none; font: inherit; font-size: 10px; color: #ccc; background: #3a3a3a;
    border: 1px solid #555; border-radius: 3px; cursor: pointer; padding: 0 5px; line-height: 15px; }
  .sel-ctl:hover { background: #4a4a4a; }
  .sel-body { max-height: 38vh; overflow-y: auto; }
  /* while EDITING, the member list keeps a FIXED height so adds/removes never
     shift the tree below it mid-gesture (the list scrolls instead) */
  .sel-block.editing .sel-body { height: 160px; max-height: 160px; overflow-y: auto; }
  .hidden-sel .sel-body { opacity: 0.72; }
  .rename-input { flex: 1 1 auto; min-width: 0; font: inherit; background: #1e1e1e;
    color: #eee; border: 1px solid #9fe8cd; border-radius: 2px; padding: 0 3px; }
  .rename-input.rename-bad { border-color: #ff6060; }
  .entry-remove { flex: none; cursor: pointer; color: #888; padding: 0 4px; }
  .entry-remove:hover { color: #fff; }

  /* ---- bottom section: build tree + bracket overlay ------------------------- */
  #tree-hint { color: #7a7a7a; padding: 0 4px 8px; line-height: 1.5; }
  #tree-host { position: relative; }
  .vlist { position: relative; }
  .tree-row { display: flex; align-items: center; gap: 4px; height: 18px; padding: 0 4px;
    border-radius: 3px; white-space: nowrap; position: relative; }
  /* ancestor rows pin to the top while scrolling an expanded subtree, so a
     collapse caret is always reachable (category tier, then group tier) */
  .cat-block > .tree-row { position: sticky; top: 0; z-index: 4; background: #252526; }
  .cat-block > div > .tree-row { position: sticky; top: 18px; z-index: 3; background: #252526; }
  .tree-row.selectable { cursor: pointer; }
  .tree-row.selectable:hover { background: #2f3a42; }
  /* ---- ONE standard feedback motion --------------------------------------
     Every state and flash color arrives and leaves through the SAME
     background-color transition. Because transitions only run on style
     CHANGES, rows that mount already-stateful (scrolling back into view,
     expanding a subtree) render their color STATICALLY — no replay; removing
     a state plays the exact same motion in reverse (bright → dark); and a
     color landing on an already-colored row cross-fades smoothly. Persistent
     states (green selected, purple hidden) stay; transient flashes (yellow
     focus, purple hide feedback) are timed classes that rise and fall. */
  .tree-row { transition: background-color 320ms ease; }
  .tree-row.sel-partial { box-shadow: inset 2px 0 0 rgba(191, 255, 228, 0.45); }

  /* transient flashes + held trail colors (same swatches, timed or held) */
  .tree-row.row-flash, .tree-row.row-flash:hover,
  .tree-row.row-flash-hold, .tree-row.row-flash-hold:hover {
    background-color: rgba(255, 233, 168, 0.35); }
  .sel-head.row-flash-purple,
  .tree-row.row-flash-purple, .tree-row.row-flash-purple:hover,
  .tree-row.row-flash-purple-hold, .tree-row.row-flash-purple-hold:hover {
    background-color: rgba(185, 139, 224, 0.40); }

  /* persistent states — they win over a passing flash (hover = brighter) */
  .tree-row.sel-covered, .tree-row.sel-covered:hover { background-color: rgba(191, 255, 228, 0.20); }
  .tree-row.sel-covered:hover { background-color: rgba(191, 255, 228, 0.30); }
  /* individually hidden member: a plain purple highlight (no strikethrough);
     wins over the green when a row is both selected and hidden */
  .tree-row.hidden-entry-row, .tree-row.hidden-entry-row:hover {
    background-color: rgba(185, 139, 224, 0.30); color: #c9a6ec; }
  .tree-row.hidden-entry-row:hover { background-color: rgba(185, 139, 224, 0.42); }

  /* a flash landing on an already-colored row BLENDS the two families
     (mirrors the 3D overlay blend) instead of swapping colors — for every
     flash color over every state color */
  .tree-row.sel-covered.row-flash, .tree-row.sel-covered.row-flash:hover,
  .tree-row.sel-covered.row-flash-hold, .tree-row.sel-covered.row-flash-hold:hover {
    background-color: rgba(223, 244, 198, 0.38); } /* yellow ⊕ green */
  .tree-row.sel-covered.row-flash-purple, .tree-row.sel-covered.row-flash-purple:hover,
  .tree-row.sel-covered.row-flash-purple-hold, .tree-row.sel-covered.row-flash-purple-hold:hover {
    background-color: rgba(188, 197, 226, 0.40); } /* purple ⊕ green */
  .tree-row.hidden-entry-row.row-flash, .tree-row.hidden-entry-row.row-flash:hover,
  .tree-row.hidden-entry-row.row-flash-hold, .tree-row.hidden-entry-row.row-flash-hold:hover {
    background-color: rgba(220, 186, 196, 0.40); } /* yellow ⊕ purple */
  .tree-row.hidden-entry-row.row-flash-purple, .tree-row.hidden-entry-row.row-flash-purple:hover,
  .tree-row.hidden-entry-row.row-flash-purple-hold, .tree-row.hidden-entry-row.row-flash-purple-hold:hover {
    background-color: rgba(185, 139, 224, 0.55); } /* purple ⊕ purple: deeper */
  .caret { width: 10px; flex: none; display: inline-block; color: #888; cursor: pointer; }
  /* expandable carets get a big forgiving hit box (reaches left into the
     indent) so a near-miss expands instead of selecting */
  .caret.exp { width: 20px; margin-left: -8px; height: 18px; line-height: 18px;
    text-align: center; border-radius: 3px; }
  .caret.exp:hover { background: #46525c; color: #eee; }
  /* the label takes the row's free space so trailing controls (the edit-mode
     ✕) sit at the right edge, never under a mid-row click */
  .tree-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

  /* brackets: flush vertical spans in the tree gutter; scroll with the
     content; not interactive (hover shows the name via the title tooltip) */
  .bracket-layer { position: absolute; left: 0; top: 0; right: 0; pointer-events: none; z-index: 5; }
  .bracket { position: absolute; width: 5px; pointer-events: auto; cursor: default;
    border-left: 2px solid #8f8f8f; border-top: 2px solid #8f8f8f; border-bottom: 2px solid #8f8f8f;
    border-radius: 2px 0 0 2px; }
  .bracket.hidden { border-color: #b98be0; }
  .bracket.pending { border-color: #9fe8cd; pointer-events: none; }

  /* top/bottom dock: the whole content flows LEFT-TO-RIGHT. #sidebar-content
     becomes a row: the selections section is a fixed left column, the tree host
     takes the rest and scrolls horizontally with its categories as columns. */
  #root[data-dock="top"] #sidebar-content, #root[data-dock="bottom"] #sidebar-content {
    display: flex; flex-direction: row; align-items: stretch; gap: 12px;
    overflow-x: auto; overflow-y: hidden; }
  #root[data-dock="top"] #selections, #root[data-dock="bottom"] #selections {
    flex: none; width: 240px; overflow-y: auto; border-bottom: none;
    border-right: 1px solid #3a3a3a; margin-bottom: 0; padding-right: 8px; }
  #root[data-dock="top"] #tree-host, #root[data-dock="bottom"] #tree-host {
    flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; }
  #root[data-dock="top"] #tree-hint, #root[data-dock="bottom"] #tree-hint { display: none; }
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
          <div id="selections"></div>
          <div id="tree-hint">left-click/drag: build (drag from a selected row removes) · right-click/drag: focus a region<br>3D: Ctrl+left = subgroups · Ctrl+right = points · click empty space: zoom out</div>
          <div id="tree-host"></div>
        </div>
      </div>
      <div id="divider" title="drag to resize the panel"></div>
      <div id="app">
        <div id="viewer-actions">
          <button id="clear-btn" disabled>Clear</button>
          <button id="commit-btn" disabled>Create selection</button>
        </div>
      </div>
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
