/**
 * save_rep — capture the CURRENT representation as a replayable `produces:
 * commands` mod. The pure half: a live-state SNAPSHOT in, a flat list of
 * primitive command strings (plus the mod-file text) out. No DOM, no Three,
 * no host — so it unit-tests directly and the command handler (commands.ts)
 * and the state-gatherer (main.ts) are thin adapters over it.
 *
 * THE IDEA. Every representation verb writes a buffer last-write-wins over a
 * resolved set. So the inverse — "what commands reproduce these buffers" — is
 * to group each per-point axis by (value) and emit ONE command per distinct
 * value over that value's point-index set (`colorpoints #3-5,#8 #e6b800`).
 * Bindings, shapes, and the background are captured as their own verbs. Only
 * what DIFFERS from the pristine default is emitted, so a default scene
 * serializes to nothing.
 *
 * WHAT IS CAPTURED (v1):
 *   - per-POINT color / size / opacity / style — index-addressable via `#N`.
 *   - channel BINDINGS on POINT axes (color/size/opacity/offset) — as `bind`.
 *     `offset` is the "smoothing and stuff" axis (a bound displacement channel).
 *   - scene SHAPE swaps (`shape points|bonds|traces <name>`) and the
 *     BACKGROUND color.
 *
 * WHAT IS DEFERRED (reported as a warning, never silently dropped):
 *   - HEADER-EDGE per-edge attributes (color/size/dash/opacity/style) and
 *     TRACE/polyline per-vertex attributes. Header edges and trace vertices
 *     are not point-index-addressable the way `#N` addresses points, and the
 *     bicolor edge PAIR has no single primitive that re-sets two independent
 *     halves — so a faithful re-address is a follow-up, not a silent guess.
 *   - bindings on EDGE / TRACE / orientation axes (same addressing gap).
 *   - SELECTIONS and hidden state (create_sele owns named selections; hide/
 *     show own visibility — both out of scope for a representation capture).
 *
 * A captured `bind` assumes its channel is DECLARED/live at replay, exactly
 * like a hand-authored bind: save_rep captures the binding, not the upstream
 * mod that produced the channel (e.g. a `smooth`/`delay` provider must be run
 * first to make its offset channel live).
 */
import type { Binding } from "./bindings.ts";
import { AXIS_DOMAIN } from "./channelmap.ts";
import { DEFAULT_COLOR, DEFAULT_OPACITY, DEFAULT_SIZE } from "./representation.ts";

/** The `# author:` a save_rep-written mod carries. */
export const SAVE_REP_AUTHOR = "save_rep";
/** Above this many emitted commands the caller LOGS the count as a warning
 * (a per-point gradient can produce hundreds — acceptable, but never silent). */
export const LARGE_REPLAY = 200;

/** point domain → the `shape` verb's domain word (mirrors SHAPE_DOMAINS in
 * commands.ts, pinned by saverep.test.ts so the two cannot drift). */
const SHAPE_DOMAIN_WORD: Record<"point" | "edge" | "vertex", "points" | "bonds" | "traces"> = {
  point: "points",
  edge: "bonds",
  vertex: "traces",
};

/** The live representation state save_rep reads — a plain data snapshot the
 * host (main.ts) fills from the rep layer, the binding registry, and the
 * scene. Everything the serializer needs and nothing it does not. */
export interface RepSnapshot {
  /** Point count — the color buffer is 3× this, the scalar buffers 1×. */
  nPoints: number;
  /** length 3N — per-point RGB (0..1), header/contract point order. */
  color: ArrayLike<number>;
  /** length N — per-point size. */
  size: ArrayLike<number>;
  /** length N — per-point opacity (0..1). */
  opacity: ArrayLike<number>;
  /** length N — per-point style REGISTRY INDEX (0 = the default). */
  style: ArrayLike<number>;
  /** style registry names, index → name (styleNames[style[p]] is p's style). */
  styleNames: readonly string[];
  /** the live channel bindings (BindingRegistry.all()). */
  bindings: readonly Binding[];
  /** the current scene background RGB (0..1). */
  background: readonly [number, number, number];
  /** the pristine scene background RGB (0..1) — passed in so main.ts's
   * BACKGROUND constant stays the single source of the default. */
  backgroundDefault: readonly [number, number, number];
  /** the shape registry read surface (ctx.shapesInfo()): each domain's
   * registered names (registration order — [0] is the default) and active. */
  shapes: readonly { domain: "point" | "edge" | "vertex"; names: string[]; active: string | null }[];
  /** true iff any HEADER-EDGE rep buffer differs from its default (its
   * capture is deferred — reported so the user is never misled). */
  edgeCustomized: boolean;
  /** true iff any TRACE/polyline rep buffer differs from its default. */
  traceCustomized: boolean;
}

export interface SerializeResult {
  /** The primitive command strings that reproduce the captured look, in a
   * deterministic replay order. */
  commands: string[];
  /** Human notes about what was NOT captured (deferred state present in the
   * scene) or a large-replay heads-up. Never truncates; only reports. */
  warnings: string[];
}

/** Round an RGB triple (0..1) to a `#rrggbb` hex string. Colors that came
 * from a color token round-trip EXACTLY (they were stored as k/255); a bound
 * or gradient value quantizes to 8-bit, which is the honest fidelity of a hex
 * command. */
export function rgbToHex(rgb: readonly [number, number, number]): string {
  const byte = (v: number): string => {
    const n = Math.min(255, Math.max(0, Math.round(v * 255)));
    return n.toString(16).padStart(2, "0");
  };
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`;
}

/**
 * Compact a set of point indices into the `#N` address grammar:
 * consecutive runs collapse to `#lo-hi`, singletons stay `#N`, and the terms
 * union with `,` (each term re-prefixed with `#`, per address.ts). Input need
 * not be sorted or unique; the output is sorted and deduped.
 *   [3,4,5,8,10,11,12] → "#3-5,#8,#10-12"
 */
export function formatPointIndices(ids: readonly number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(sorted[i] === sorted[j] ? `#${sorted[i]}` : `#${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

/** Emit one command per DISTINCT value over its point set. `keyOf` buckets a
 * point's value (the hex string / the number text / the style name); `argOf`
 * turns a bucket key back into the command's value argument. Buckets are
 * ordered by their smallest point index so the output is deterministic.
 * `skip` (bound points) and `isDefault` points are excluded. */
function bucketPointAxis(
  verb: string,
  nPoints: number,
  skip: ReadonlySet<number>,
  keyOf: (p: number) => string | null, // null = default / not capturable → excluded
  argOf: (key: string) => string,
): string[] {
  const buckets = new Map<string, number[]>();
  for (let p = 0; p < nPoints; p++) {
    if (skip.has(p)) continue;
    const key = keyOf(p);
    if (key === null) continue;
    const arr = buckets.get(key);
    if (arr) arr.push(p);
    else buckets.set(key, [p]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[1][0] - b[1][0])
    .map(([key, ids]) => `${verb} ${formatPointIndices(ids)} ${argOf(key)}`);
}

/** Point ids covered by a binding on `axis`, across all bindings. Used to
 * EXCLUDE bound points from the per-point emit — the `bind` command
 * reproduces them (and re-emitting per-point values would freeze what the
 * binding is meant to re-derive per frame). */
function boundPointsOn(bindings: readonly Binding[], axis: string): Set<number> {
  const s = new Set<number>();
  for (const b of bindings) {
    if (b.axis === axis && AXIS_DOMAIN[b.axis] === "point") {
      for (const p of b.points) s.add(p);
    }
  }
  return s;
}

/**
 * The serializer: a live snapshot → the primitive commands that reproduce it.
 * Pure and deterministic.
 */
export function serializeRepCommands(snap: RepSnapshot): SerializeResult {
  const commands: string[] = [];
  const warnings: string[] = [];
  const noSkip = new Set<number>(); // style is not a bindable axis — nothing to exclude

  const colorBound = boundPointsOn(snap.bindings, "color");
  const sizeBound = boundPointsOn(snap.bindings, "size");
  const opacityBound = boundPointsOn(snap.bindings, "opacity");

  // The rep buffers are Float32Array, so a default value read back is the
  // FLOAT32 of the constant, not the double — compare in float32 space
  // (Math.fround) or every pristine point would read as customized.
  const defColor: [number, number, number] = [
    Math.fround(DEFAULT_COLOR[0]), Math.fround(DEFAULT_COLOR[1]), Math.fround(DEFAULT_COLOR[2]),
  ];
  const defSize = Math.fround(DEFAULT_SIZE);
  const defOpacity = Math.fround(DEFAULT_OPACITY);

  // --- scene-level: background, then shapes ---------------------------------
  if (
    snap.background[0] !== snap.backgroundDefault[0] ||
    snap.background[1] !== snap.backgroundDefault[1] ||
    snap.background[2] !== snap.backgroundDefault[2]
  ) {
    commands.push(`background ${rgbToHex(snap.background as [number, number, number])}`);
  }
  for (const s of snap.shapes) {
    const def = s.names[0] ?? null; // the first-registered shape is the default-active
    if (s.active !== null && s.active !== def) {
      commands.push(`shape ${SHAPE_DOMAIN_WORD[s.domain]} ${s.active}`);
    }
  }

  // --- per-point axes (color, size, opacity, style) -------------------------
  commands.push(
    ...bucketPointAxis(
      "colorpoints", snap.nPoints, colorBound,
      (p) => {
        const r = snap.color[p * 3], g = snap.color[p * 3 + 1], b = snap.color[p * 3 + 2];
        if (r === defColor[0] && g === defColor[1] && b === defColor[2]) return null;
        return rgbToHex([r, g, b]);
      },
      (hex) => hex,
    ),
  );
  commands.push(
    ...bucketPointAxis(
      "pointsize", snap.nPoints, sizeBound,
      (p) => (snap.size[p] === defSize ? null : String(snap.size[p])),
      (v) => v,
    ),
  );
  commands.push(
    ...bucketPointAxis(
      "pointopacity", snap.nPoints, opacityBound,
      (p) => (snap.opacity[p] === defOpacity ? null : String(snap.opacity[p])),
      (v) => v,
    ),
  );
  commands.push(
    ...bucketPointAxis(
      "stylepoints", snap.nPoints, noSkip,
      (p) => {
        const idx = snap.style[p];
        if (idx === 0) return null; // index 0 = the default style
        const name = snap.styleNames[idx];
        return name ?? null; // an unknown index is skipped (warned below)
      },
      (name) => name,
    ),
  );
  // A style index with no registered name would be silently uncapturable —
  // report it rather than drop it.
  for (let p = 0; p < snap.nPoints; p++) {
    const idx = snap.style[p];
    if (idx !== 0 && snap.styleNames[idx] === undefined) {
      warnings.push(`style index ${idx} on point ${p} has no registered name — its style was not captured`);
      break;
    }
  }

  // --- bindings on POINT axes; defer the rest -------------------------------
  for (const b of snap.bindings) {
    if (AXIS_DOMAIN[b.axis] !== "point") {
      warnings.push(
        `binding "${b.channel}" → ${b.axis} was not captured — ${AXIS_DOMAIN[b.axis]} axes are not point-index-addressable`,
      );
      continue;
    }
    const target = formatPointIndices(b.points);
    if (target === "") continue; // an empty binding (should not occur) emits nothing
    const range = b.range ? ` ${b.range[0]} ${b.range[1]}` : "";
    // The palette must ride the replay or the saved look silently reverts to
    // the default ramp. `undefined` ⟺ the default (Binding.palette is
    // canonical), so a default binding emits the byte-identical line it did
    // before palettes existed.
    const palette = b.palette === undefined ? "" : ` ?palette=${b.palette}`;
    commands.push(`bind ${target} ${b.channel} ${b.axis}${range}${palette}`);
  }

  // --- deferred per-element edge/trace attributes ---------------------------
  if (snap.edgeCustomized) {
    warnings.push(
      "header-edge attributes (bond color/size/dash/opacity/style) were not captured — header edges are not point-index-addressable",
    );
  }
  if (snap.traceCustomized) {
    warnings.push(
      "trace/polyline attributes (trace color/size/opacity/style) were not captured — trace vertices are not point-index-addressable",
    );
  }

  if (commands.length >= LARGE_REPLAY) {
    warnings.push(`captured ${commands.length} commands — a large replay (nothing was truncated)`);
  }
  return { commands, warnings };
}

const MOD_FILE_MAGIC = "# molaro-mod";

/** Escape a command string for a Python double-quoted literal. */
function pyStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the `produces: commands` mod file text for a captured look. The mod
 * ignores `target_indices` (a commands mod may) and returns the static list,
 * so `<name>` replays identically. Round-trips through parseModFile.
 */
export function buildRepMod(name: string, commands: readonly string[], description?: string): string {
  const desc =
    description ??
    `saved representation — ${commands.length} command${commands.length === 1 ? "" : "s"} capturing the current look`;
  const head = [
    MOD_FILE_MAGIC,
    `# name: ${name}`,
    `# kind: analysis`,
    `# produces: commands`,
    `# author: ${SAVE_REP_AUTHOR}`,
    `# description: ${desc}`,
  ];
  const body =
    commands.length === 0
      ? "    return []"
      : ["    return [", ...commands.map((c) => `        ${pyStr(c)},`), "    ]"].join("\n");
  return `${head.join("\n")}\n\ndef compute(data, target_indices):\n${body}\n`;
}
