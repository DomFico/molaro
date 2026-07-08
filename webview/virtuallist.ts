/**
 * Fixed-row-height virtual list (Increment 4.8, A4). Renders only the rows in (or
 * near) the viewport so a list of thousands stays fast, with no truncation.
 *
 * It positions a full-height spacer `el` and absolutely-places just the visible
 * rows inside it. Scroll is observed in the CAPTURE phase on a stable ancestor so
 * it works whether the actual scroller is that ancestor (side dock) or a nested
 * per-column scroller (top/bottom dock). The item model is flat and fixed-height
 * — a drill-to-points expansion splices point items into the flat array (see
 * sidebar.ts), keeping every row the same height.
 */
export class VirtualList {
  readonly el: HTMLElement;
  private count: number;
  private readonly rowHeight: number;
  private readonly overscan: number;
  private readonly renderRow: (index: number) => HTMLElement;
  private readonly scrollRoot: HTMLElement;
  private readonly nodes = new Map<number, HTMLElement>();
  private readonly onScroll = (): void => this.update();

  constructor(
    scrollRoot: HTMLElement,
    count: number,
    rowHeight: number,
    renderRow: (index: number) => HTMLElement,
    overscan = 8,
  ) {
    this.scrollRoot = scrollRoot;
    this.count = count;
    this.rowHeight = rowHeight;
    this.overscan = overscan;
    this.renderRow = renderRow;
    this.el = document.createElement("div");
    this.el.className = "vlist";
    this.el.style.position = "relative";
    this.el.style.height = `${count * rowHeight}px`;
    // Capture-phase catches scrolls from `scrollRoot` OR any descendant scroller.
    scrollRoot.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onScroll);
    window.addEventListener("panelrelayout", this.onScroll);
    this.update();
  }

  /** Change the item count (e.g. after a drill expand/collapse) and re-window. */
  setCount(count: number): void {
    this.count = count;
    this.el.style.height = `${count * this.rowHeight}px`;
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.update();
  }

  /** Re-apply state (classes) to the currently-rendered rows. */
  forEachRendered(fn: (index: number, node: HTMLElement) => void): void {
    for (const [i, node] of this.nodes) fn(i, node);
  }

  /** Scroll the actual scroller so item `index` is centered, then render it. */
  scrollToIndex(index: number): void {
    const parent = scrollParent(this.el);
    if (!parent) return;
    const localTop =
      this.el.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
    parent.scrollTop = localTop + index * this.rowHeight - parent.clientHeight / 2;
    this.update();
  }

  dispose(): void {
    this.scrollRoot.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onScroll);
    window.removeEventListener("panelrelayout", this.onScroll);
  }

  private update(): void {
    if (this.count === 0) return;
    const parent = scrollParent(this.el) ?? this.scrollRoot;
    const pRect = parent.getBoundingClientRect();
    const eRect = this.el.getBoundingClientRect();
    const top = pRect.top - eRect.top; // list-local y at the viewport top
    const bottom = pRect.bottom - eRect.top;
    let first = Math.floor(top / this.rowHeight) - this.overscan;
    let last = Math.ceil(bottom / this.rowHeight) + this.overscan;
    first = Math.max(0, first);
    last = Math.min(this.count - 1, last);
    for (const [i, node] of this.nodes) {
      if (i < first || i > last) {
        node.remove();
        this.nodes.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (this.nodes.has(i)) continue;
      const node = this.renderRow(i);
      node.style.position = "absolute";
      node.style.top = `${i * this.rowHeight}px`;
      node.style.left = "0";
      node.style.right = "0";
      node.style.height = `${this.rowHeight}px`;
      this.el.appendChild(node);
      this.nodes.set(i, node);
    }
  }
}

/** Nearest scrollable ancestor (overflow auto/scroll on the relevant axis). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const s = getComputedStyle(node);
    if (/(auto|scroll)/.test(s.overflowY + s.overflow + s.overflowX)) return node;
    node = node.parentElement;
  }
  return null;
}
