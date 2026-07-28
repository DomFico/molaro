/**
 * Unit tests for the command registry's built-ins that need no DOM — the
 * help/? verb and the registry surface. Pure, no DOM. Run from viewer/:
 * node --test tests/commands.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Header } from "../contract/contract.ts";
import { buildTree } from "../webview/classification.ts";
import { Hierarchy, type Entry } from "../webview/sets.ts";
import {
  applyScalarsToAxis,
  commandMacroRefusal,
  completeCommand,
  createCommandRegistry,
  HELP_TEXT,
  installModList,
  isFileAlreadyGone,
  makeAnalysisModHandler,
  modInstallReport,
  parseColor,
  parseModParams,
  parseOpacity,
  parseSize,
  runCommandMacro,
  type CommandContext,
  type CommandResult,
} from "../webview/commands.ts";
import {
  getRecipe,
  listRecipes,
  parseModFile,
  registerRecipe,
  unregisterRecipe,
  type AnalysisMod,
} from "../webview/recipes.ts";
import { BIND_SIZE_MAX, bindTypedResult } from "../webview/claudebind.ts";
import type { ChannelDecl } from "../webview/channelmap.ts";
import { BindingRegistry, type Binding } from "../webview/bindings.ts";
import { AXIS_DOMAIN, COLOR_AXES, OFFSET_AXIS, SCALAR_AXES, VECTOR_AXES } from "../webview/channelmap.ts";
import { paletteNames } from "../webview/palettes.ts";
import { neighborSubgroups } from "../webview/picking.ts";

function makeHeader(): Header {
  const category = [0, 0, 1];
  const group_id = [0, 0, 1];
  const subgroup_id = [0, 0, 1];
  return {
    version: "0.1.0", name: "t", n_points: 3, n_frames: 1, units: "m", bbox: null,
    points: { type: ["a", "b", "c"], group_id, subgroup_id, category },
    categories: ["c0", "c1"], groups: { "0": "g0", "1": "g1" },
    subgroups: { "0": "s0", "1": "s1" }, edges: [], polylines: [], channels: [],
  };
}

/** Coordinates for the 3-point fixture, laid out on the x-axis so the
 * distances a `?within=` test asserts are readable: p0 (subgroup 0) at the
 * origin, p1 (subgroup 0) at 1, p2 (subgroup 1) at 2. */
const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);

function makeRegistry(fixture?: { traceVertices?: number[] }) {
  const header = makeHeader();
  const hierarchy = new Hierarchy(header);
  const calls = { focus: 0, frame: 0, flash: 0 };
  // stateful stubs: record what the handlers asked for and mimic the model's
  // surface (collision error for "taken", auto-name, idempotence via state)
  const commits: { entries: Entry[]; name: string | null; hide: boolean }[] = [];
  const hiddenState = { whole: new Map<string, boolean>(), pts: new Set<number>(), members: new Set<string>() };
  // two committed selections so batch-hide / @all / rename have material
  const sels = new Map<string, readonly Entry[]>([
    ["stored", [{ level: "subgroup", id: 0 }, { level: "point", id: 2 }]],
    ["second", [{ level: "subgroup", id: 1 }]],
  ]);
  const chanDecls: ChannelDecl[] = [
    { name: "energy", scope: "per_point_per_frame", components: 1, min: 0 },
    { name: "mass", scope: "per_point", components: 1, min: 1, max: 3 },
    { name: "time", scope: "per_frame", components: 1, min: 0, max: 9 },
    { name: "flow", scope: "per_point_per_frame", components: 3 },
  ];
  const chanValues = new Map<string, { values: number[]; frame: number | null }>([
    ["energy", { values: [0, 1.25, 2.5], frame: 4 }],
    ["mass", { values: [1, 2, 3], frame: null }],
    ["flow", { values: [1, 0, 0, 0, 1, 0, 0, 0, 1], frame: 4 }],
  ]);
  const bindingReg = new BindingRegistry();
  const bindCalls: { b: Binding; scalars: number[] }[] = [];
  const orientationOps: { vertexIds: number[]; values: number[] }[] = [];
  const offsetOps: { points: number[]; values: number[] }[] = [];
  const elemEachOps: { axis: string; ids: number[]; values: number[] }[] = [];
  const styleOps: { kind: "points" | "edges" | "trace"; ids: number[]; index: number }[] = [];
  const shapeState: Record<string, string[]> = { point: ["sphere"], edge: ["tube"], vertex: ["tube", "ribbon"] };
  const shapeActive: Record<string, string> = { point: "sphere", edge: "tube", vertex: "tube" };
  const shapeOps: { domain: string; label: string }[] = [];
  const bgOps: [number, number, number][] = [];
  const refOps: { names: string[]; hidden: boolean }[] = [];
  const memberOps: { name: string; mode: "add" | "remove"; entries: Entry[] }[] = [];
  const colorOps: { points: number[]; rgb: [number, number, number] }[] = [];
  const colorEachOps: { points: number[]; rgb: number[] }[] = [];
  const eachOps: { kind: "size" | "opacity"; points: number[]; values: number[] }[] = [];
  const modRuns: { name: string; points: number[]; expr: string }[] = [];
  const modRunCode: string[] = [];
  const rmArms: string[][] = [];
  const saveRepCalls: { name: string; source: string }[] = [];
  const edgeOps: { edgeIds: number[]; rgb: [number, number, number] }[] = [];
  const endsOps: { ids: number[]; a: number[]; b: number[] }[] = [];
  // the endpoint-snapshot READ source: three distinct per-point RGBs so a
  // half-swap (A read from B's endpoint) is detectable
  const pointColorBuf = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  // a chain over the 3 points: edge 0 sits inside c0 ({0,1}); edge 1 crosses
  // the category boundary (point 1 in c0, point 2 in c1) — the contained-vs-
  // incident distinction is decidable from these two alone
  const edges: [number, number][] = [[0, 1], [1, 2]];
  const traceOps: { vertexIds: number[]; rgb: [number, number, number] }[] = [];
  // Default: ONE polyline vertex, point 0 (subgroup s0). Point 1 shares s0
  // but is NOT a vertex (pins the map-up); s1 owns no vertex (pins the
  // nomatch). The ORIENTATION tests override with [0, 2] — a NON-identity
  // vertex→point map (vertex 1 → point 2), because with [0] alone the
  // vertex-id and point-id spaces are numerically identical and a
  // space-mixing regression is undetectable (a vacuous guard).
  const traceVertices: number[] = fixture?.traceVertices ?? [0];
  const sizeOps: { kind: "points" | "edges" | "trace"; ids: number[]; size: number }[] = [];
  const dashOps: { ids: number[]; dash: number }[] = [];
  const opacityOps: { kind: "points" | "edges" | "trace"; ids: number[]; opacity: number }[] = [];
  // Produced-edge fixture: tests push groups/pairs in, the mock serves the
  // SAME read surface main.ts wires (groups/groupIds/activePairs), and every
  // produced write is recorded — so the verbs' produced arms are assertable
  // without a renderer. Empty by default: the legacy scenes' byte-identity
  // tests run over exactly this default.
  const produced = {
    groups: [] as { name: string; baseId: number; count: number; active: boolean }[],
    pairs: new Map<number, [number, number]>(),
  };
  const producedOps: { kind: string; ids: number[]; value?: unknown; a?: number[]; b?: number[] }[] = [];
  // ctx.beginStroke/endStroke markers — the ONE-stroke composition proof
  const strokeEvents: ("begin" | "end")[] = [];
  // every `?within=` query the handlers asked for — the instrument behind the
  // "a macro must not run the neighbourhood twice" pin
  const neighborhoodCalls: { points: number[]; radius: number; frame: number }[] = [];
  const ctx: CommandContext = {
    hierarchy,
    tree: buildTree(header),
    pointTypes: header.points.type,
    committedEntries: () => sels,
    // the `?within=` query, over the REAL indexed implementation so the verb
    // tests exercise what ships. Geometry: p0 (sub 0) at the origin, p1 (sub 0)
    // one unit out, p2 (sub 1) two units out — so a radius under 2 from p0
    // finds nothing and a radius over 2 finds subgroup 1.
    neighborhoodSubgroups: (points, radius, frame) => {
      neighborhoodCalls.push({ points: [...points], radius, frame });
      if (frame >= header.n_frames) return null;
      const own = new Set<number>(points.map((p) => hierarchy.subgroupOfPoint(p)));
      return neighborSubgroups(
        POSITIONS, points, [0, 1, 2], header.points.subgroup_id, own, radius,
      );
    },
    displayedFrame: () => 0,
    frameCount: () => header.n_frames,
    focusPoints: () => { calls.focus++; },
    frameVisible: () => { calls.frame++; },
    flashPointRows: () => { calls.flash++; },
    commitEntries: (entries, name, hide = false) => {
      if (name === "taken") return { error: `a selection named "taken" already exists` };
      commits.push({ entries, name, hide });
      const pts = new Set<number>();
      for (const e of entries) for (const p of hierarchy.pointsOf(e)) pts.add(p);
      return { name: name ?? "selection_1", points: pts.size };
    },
    setRefsHidden: (ops, hidden) => {
      // one batch = one stroke in the real model; the stub records the batch
      refOps.push({ names: ops.map((o) => o.name), hidden });
      let affected = 0;
      let changed = 0;
      for (const op of ops) {
        const stored = sels.get(op.name);
        if (!stored) return null;
        if (op.entries === null) {
          if ((hiddenState.whole.get(op.name) ?? false) !== hidden) {
            hiddenState.whole.set(op.name, hidden);
            let n = 0;
            for (const e of stored) n += hierarchy.pointsOf(e).length;
            affected += n;
            changed++;
          }
        } else {
          let n = 0;
          for (const e of op.entries) {
            const key = `${e.level}:${e.id}`;
            if (hiddenState.members.has(key) !== hidden) {
              if (hidden) hiddenState.members.add(key);
              else hiddenState.members.delete(key);
              n += hierarchy.pointsOf(e).length;
            }
          }
          if (n > 0) changed++;
          affected += n;
        }
      }
      return { affected, changed };
    },
    selectionsInfo: () =>
      [...sels.keys()].map((name) => {
        let points = 0;
        for (const e of sels.get(name)!) points += hierarchy.pointsOf(e).length;
        return { name, points, hidden: hiddenState.whole.get(name) ?? false };
      }),
    renameSelection: (oldName, newName) => {
      if (!sels.has(oldName)) return { error: `no selection named "${oldName}"` };
      if (newName === "all") return { error: `"all" is reserved` };
      if (sels.has(newName)) return { error: `a selection named "${newName}" already exists` };
      sels.set(newName, sels.get(oldName)!);
      sels.delete(oldName);
      return { ok: true };
    },
    mutateMembers: (name, mode, entries) => {
      const stored = sels.get(name);
      if (!stored) return null;
      memberOps.push({ name, mode, entries });
      const keys = new Set(stored.map((e) => `${e.level}:${e.id}`));
      let next = [...stored];
      let points = 0;
      for (const e of entries) {
        const key = `${e.level}:${e.id}`;
        if (mode === "add") {
          if (keys.has(key)) continue; // idempotent, like addToTarget
          keys.add(key);
          next.push(e);
          points += hierarchy.pointsOf(e).length;
        } else {
          if (!keys.has(key)) continue; // exact members only — never carves
          keys.delete(key);
          next = next.filter((x) => `${x.level}:${x.id}` !== key);
          points += hierarchy.pointsOf(e).length;
        }
      }
      sels.set(name, next);
      return { points, remaining: next.length };
    },
    deleteSelections: (names) => {
      if (names.some((n) => !sels.has(n))) return null;
      const pts = new Set<number>();
      for (const n of names) {
        for (const e of sels.get(n)!) for (const p of hierarchy.pointsOf(e)) pts.add(p);
        sels.delete(n);
        hiddenState.whole.delete(n);
      }
      return { deleted: names.length, points: pts.size };
    },
    setMembersHiddenIn: (name, entries, hidden) => {
      // whole-MEMBER stub: tracks member keys; affected = points of changed members
      let affected = 0;
      for (const e of entries) {
        const key = `${e.level}:${e.id}`;
        if (hiddenState.members.has(key) !== hidden) {
          if (hidden) hiddenState.members.add(key);
          else hiddenState.members.delete(key);
          affected += hierarchy.pointsOf(e).length;
        }
      }
      return { affected, wholeHidden: hiddenState.whole.get(name) ?? false };
    },
    clearSelectionHidden: (name) => {
      let n = hiddenState.pts.size + hiddenState.members.size;
      hiddenState.pts.clear();
      hiddenState.members.clear();
      if (hiddenState.whole.get(name)) {
        for (const e of sels.get(name) ?? []) n += hierarchy.pointsOf(e).length;
        hiddenState.whole.set(name, false);
      }
      return { affected: n };
    },
    showPointsCovering: (points) => {
      const delta = points.filter((p) => hiddenState.pts.has(p));
      for (const p of delta) hiddenState.pts.delete(p);
      return delta.length;
    },
    showAll: () => {
      let n = hiddenState.pts.size + hiddenState.members.size;
      hiddenState.pts.clear();
      hiddenState.members.clear();
      for (const [k, v] of hiddenState.whole) {
        if (v) {
          for (const e of sels.get(k) ?? []) n += hierarchy.pointsOf(e).length;
          hiddenState.whole.set(k, false);
        }
      }
      return n;
    },
    colorPoints: (points, rgb) => {
      // one call = one stroke in the real wiring; the stub records the write
      colorOps.push({ points: [...points], rgb });
      return points.length;
    },
    colorPointsEach: (points, rgb) => {
      colorEachOps.push({ points: [...points], rgb: [...rgb] });
      return points.length;
    },
    sizePointsEach: (points, values) => {
      eachOps.push({ kind: "size", points: [...points], values: [...values] });
      return points.length;
    },
    opacityPointsEach: (points, values) => {
      eachOps.push({ kind: "opacity", points: [...points], values: [...values] });
      return points.length;
    },
    // The bake/bind gate's read surface: one channel per gate case —
    // "energy" declares min ONLY (partial: the explicit-range path),
    // "mass" is static per_point with a full range, "time" is per-frame
    // (a series — refused), "flow" is 3-wide (refused for scalar axes).
    channels: () => chanDecls,
    channelValues: (name) => chanValues.get(name) ?? null,
    // A REAL registry behind the binding stubs — the verbs' semantics
    // (last-bind-wins, element-level release) are the registry's, and the
    // stub records what the composite (main.ts's one stroke) was asked for.
    createBinding: (b, scalars) => {
      bindCalls.push({ b: { ...b, points: [...b.points] }, scalars: [...scalars] });
      return bindingReg.add(b);
    },
    releaseBindings: (sel, axis) => {
      // mirror the main.ts composite: each axis gets ITS OWN id space, and
      // released OFFSET coverage is zeroed (captured BEFORE the release,
      // recorded here into offsetOps as the composite's zero write would be)
      const zeroIds: number[] = [];
      if (axis === null || axis === OFFSET_AXIS) {
        const req = sel.points === null ? null : new Set(sel.points);
        for (const b of bindingReg.all()) {
          if (b.axis !== OFFSET_AXIS) continue;
          for (const p of b.points) if (req === null || req.has(p)) zeroIds.push(p);
        }
      }
      const total = { touched: 0, removed: 0, points: 0, offsetZeroed: 0 };
      const acc = (s: { touched: number; removed: number; points: number }): void => {
        total.touched += s.touched;
        total.removed += s.removed;
        total.points += s.points;
      };
      const idsFor = (a: (typeof SCALAR_AXES)[number] | (typeof VECTOR_AXES)[number]) =>
        AXIS_DOMAIN[a] === "point" ? sel.points : AXIS_DOMAIN[a] === "edge" ? sel.edges : sel.vertices;
      for (const a of [...SCALAR_AXES, ...VECTOR_AXES]) {
        if (axis === null || axis === a) acc(bindingReg.release(idsFor(a), a));
      }
      if (total.touched > 0 && zeroIds.length > 0) {
        offsetOps.push({ points: [...zeroIds], values: new Array<number>(zeroIds.length * 3).fill(0) });
        total.offsetZeroed = zeroIds.length;
      }
      return total;
    },
    listBindings: () => bindingReg.all(),
    orientationVerticesEach: (vertexIds, values) => {
      orientationOps.push({ vertexIds: [...vertexIds], values: [...values] });
      return vertexIds.length;
    },
    offsetPointsEach: (points, values) => {
      offsetOps.push({ points: [...points], values: [...values] });
      return points.length;
    },
    colorEdgesEach: (ids, rgb) => {
      elemEachOps.push({ axis: "bondcolor", ids: [...ids], values: [...rgb] });
      return ids.length;
    },
    colorEdgesEnds: (ids, aFlat, bFlat) => {
      endsOps.push({ ids: [...ids], a: [...aFlat], b: [...bFlat] });
      return ids.length;
    },
    colorEdgesEndsEach: (ids, aFlat, bFlat) => {
      // records into the SAME log as the snapshot writer — one spine in the
      // real wiring, so the stub keeps one log too
      endsOps.push({ ids: [...ids], a: [...aFlat], b: [...bFlat] });
      return ids.length;
    },
    pointColors: () => pointColorBuf,
    sizeEdgesEach: (ids, values) => {
      elemEachOps.push({ axis: "bondsize", ids: [...ids], values: [...values] });
      return ids.length;
    },
    opacityEdgesEach: (ids, values) => {
      elemEachOps.push({ axis: "bondopacity", ids: [...ids], values: [...values] });
      return ids.length;
    },
    colorTraceEach: (ids, rgb) => {
      elemEachOps.push({ axis: "tracecolor", ids: [...ids], values: [...rgb] });
      return ids.length;
    },
    sizeTraceEach: (ids, values) => {
      elemEachOps.push({ axis: "tracesize", ids: [...ids], values: [...values] });
      return ids.length;
    },
    opacityTraceEach: (ids, values) => {
      elemEachOps.push({ axis: "traceopacity", ids: [...ids], values: [...values] });
      return ids.length;
    },
    stylePoints: (points, index) => {
      styleOps.push({ kind: "points", ids: [...points], index });
      return points.length;
    },
    styleEdges: (edgeIds, index) => {
      styleOps.push({ kind: "edges", ids: [...edgeIds], index });
      return edgeIds.length;
    },
    styleTrace: (vertexIds, index) => {
      styleOps.push({ kind: "trace", ids: [...vertexIds], index });
      return vertexIds.length;
    },
    styleNames: () => ["standard", "matte"],
    styleIndexOf: (name) => ["standard", "matte"].indexOf(name),
    setShape: (domain, label) => {
      const names = shapeState[domain] ?? [];
      if (!names.includes(label)) return null;
      const prev = shapeActive[domain];
      shapeActive[domain] = label;
      shapeOps.push({ domain, label });
      // the ribbon mirrors the real generator's declared requirement
      return { prev, ...(label === "ribbon" ? { requiresAxis: "orientation" as const } : {}) };
    },
    shapesInfo: () =>
      (["point", "edge", "vertex"] as const).map((domain) => ({
        domain, names: shapeState[domain] ?? [], active: shapeActive[domain] ?? null,
      })),
    setBackground: (rgb) => {
      bgOps.push([...rgb] as [number, number, number]);
    },
    edges,
    colorEdges: (edgeIds, rgb) => {
      edgeOps.push({ edgeIds: [...edgeIds], rgb });
      return edgeIds.length;
    },
    traceVertices,
    colorTrace: (vertexIds, rgb) => {
      traceOps.push({ vertexIds: [...vertexIds], rgb });
      return vertexIds.length;
    },
    sizePoints: (points, size) => {
      sizeOps.push({ kind: "points", ids: [...points], size });
      return points.length;
    },
    sizeEdges: (edgeIds, size) => {
      sizeOps.push({ kind: "edges", ids: [...edgeIds], size });
      return edgeIds.length;
    },
    sizeTrace: (vertexIds, size) => {
      sizeOps.push({ kind: "trace", ids: [...vertexIds], size });
      return vertexIds.length;
    },
    opacityPoints: (points, opacity) => {
      opacityOps.push({ kind: "points", ids: [...points], opacity });
      return points.length;
    },
    opacityEdges: (edgeIds, opacity) => {
      opacityOps.push({ kind: "edges", ids: [...edgeIds], opacity });
      return edgeIds.length;
    },
    opacityTrace: (vertexIds, opacity) => {
      opacityOps.push({ kind: "trace", ids: [...vertexIds], opacity });
      return vertexIds.length;
    },
    dashEdges: (edgeIds, dash) => {
      dashOps.push({ ids: [...edgeIds], dash });
      return edgeIds.length;
    },
    dashEdgesEach: (edgeIds, values) => {
      elemEachOps.push({ axis: "bonddash", ids: [...edgeIds], values: [...values] });
      return edgeIds.length;
    },
    runAnalysisMod: (mod, points, expr, params) => {
      // params only appears on the pushed object when present, so existing
      // deepEqual assertions (which never pass params) stay unchanged.
      modRuns.push({ name: mod.name, points: [...points], expr, ...(params ? { params } : {}) });
      // The CODE the handler would ship to the producer — the only thing that
      // separates one version of a mod from another (kept out of modRuns, which
      // is deepEqual-asserted elsewhere).
      modRunCode.push(mod.code);
    },
    armRmDeletion: (names) => {
      rmArms.push([...names]);
    },
    // save_rep: a minimal DEFAULT snapshot (nothing customized) — tests that
    // need a captured look override repSnapshot per case. saveRep records the
    // written source so the round-trip can be asserted.
    repSnapshot: () => ({
      nPoints: header.n_points,
      color: new Float32Array(header.n_points * 3).fill(0.9),
      size: new Float32Array(header.n_points).fill(3),
      opacity: new Float32Array(header.n_points).fill(1),
      style: new Float32Array(header.n_points),
      styleNames: ["standard", "matte"],
      bindings: bindingReg.all(),
      background: [0x1e / 255, 0x1e / 255, 0x1e / 255] as [number, number, number],
      backgroundDefault: [0x1e / 255, 0x1e / 255, 0x1e / 255] as [number, number, number],
      shapes: (["point", "edge", "vertex"] as const).map((domain) => ({
        domain, names: shapeState[domain] ?? [], active: shapeActive[domain] ?? null,
      })),
      edgeCustomized: false,
      traceCustomized: false,
    }),
    saveRep: (name, source) => {
      saveRepCalls.push({ name, source });
    },
    // Produced-edge surface: reads over the test fixture, writes recorded.
    producedEdges: {
      groups: () => produced.groups.map((g) => ({ ...g })),
      groupIds: (name) => {
        const g = produced.groups.find((x) => x.name === name);
        return g ? Array.from({ length: g.count }, (_, i) => g.baseId + i) : null;
      },
      activePairs: () => {
        const out: { id: number; a: number; b: number }[] = [];
        for (const g of produced.groups) {
          if (!g.active) continue;
          for (let i = 0; i < g.count; i++) {
            const id = g.baseId + i;
            const [a, b] = produced.pairs.get(id) ?? [0, 0];
            out.push({ id, a, b });
          }
        }
        return out;
      },
      colorEdges: (ids, rgb) => {
        producedOps.push({ kind: "color", ids: [...ids], value: rgb });
        return ids.length;
      },
      colorEdgesEnds: (ids, aFlat, bFlat) => {
        producedOps.push({ kind: "ends", ids: [...ids], a: [...aFlat], b: [...bFlat] });
        return ids.length;
      },
      sizeEdges: (ids, size) => {
        producedOps.push({ kind: "size", ids: [...ids], value: size });
        return ids.length;
      },
      opacityEdges: (ids, opacity) => {
        producedOps.push({ kind: "opacity", ids: [...ids], value: opacity });
        return ids.length;
      },
      dashEdges: (ids, dash) => {
        producedOps.push({ kind: "dash", ids: [...ids], value: dash });
        return ids.length;
      },
      styleEdges: (ids, index) => {
        producedOps.push({ kind: "style", ids: [...ids], value: index });
        return ids.length;
      },
    },
    beginStroke: () => {
      strokeEvents.push("begin");
    },
    endStroke: () => {
      strokeEvents.push("end");
    },
  };
  return {
    registry: createCommandRegistry(ctx),
    ctx,
    calls, commits, hiddenState, refOps, memberOps,
    colorOps, colorEachOps, eachOps, edgeOps, endsOps, traceOps, sizeOps, dashOps, opacityOps, modRuns, modRunCode, rmArms, sels,
    bindCalls, bindingReg, orientationOps, offsetOps, elemEachOps, styleOps, shapeOps, shapeActive, bgOps,
    saveRepCalls,
    produced, producedOps, strokeEvents, neighborhoodCalls,
  };
}

test("help and ? return a non-empty ok summary pointing at the full reference", () => {
  const { registry, calls } = makeRegistry();
  for (const cmd of ["help", "?"]) {
    const res = registry.runCommand(cmd);
    assert.equal(res.status, "ok", cmd);
    assert.ok(res.message.length > 0);
    assert.match(res.message, /docs\/COMMANDS\.md/);
    assert.match(res.message, /@name/); // the summary covers the grammar essentials
    assert.match(res.message, /#N/);
  }
  assert.equal(registry.runCommand("help").message, HELP_TEXT);
  assert.equal(calls.focus + calls.frame + calls.flash, 0, "help drives no viewer action");
});

test("help is an ordinary registry verb (present in the autocomplete pool)", () => {
  const { registry } = makeRegistry();
  const verbs = registry.verbs();
  assert.ok(verbs.includes("help"));
  assert.ok(verbs.includes("?"));
  assert.ok(verbs.includes("view"));
});

test("help <verb> prints the registered one-liner; unknown verb is a nomatch", () => {
  const { registry } = makeRegistry();
  const res = registry.runCommand("help view");
  assert.equal(res.status, "ok");
  assert.match(res.message, /^view — .+/);
  assert.match(registry.runCommand("help ?").message, /alias of help/);
  const miss = registry.runCommand("help bogus");
  assert.equal(miss.status, "nomatch");
  assert.match(miss.message, /no such command: bogus/);
});

test("create_sele commits the resolved entries AT THEIR NATURAL LEVEL", () => {
  const { registry, commits } = makeRegistry();
  // a category-level path stays ONE coarse entry (never expanded to points)
  let res = registry.runCommand("create_sele c0");
  assert.equal(res.status, "ok");
  assert.equal(res.message, `created "selection_1" — 2 points`);
  assert.deepEqual(commits.at(-1),
    { entries: [{ level: "category", id: 0 }], name: null, hide: false });
  // a leaf path stays point entries (never collapsed to a coarser handle)
  registry.runCommand("create_sele c0.g0.s0.*");
  assert.deepEqual(commits.at(-1)?.entries, [{ level: "point", id: 0 }, { level: "point", id: 1 }]);
  // #N is a single point entry
  registry.runCommand("create_sele #1");
  assert.deepEqual(commits.at(-1)?.entries, [{ level: "point", id: 1 }]);
  // @name contributes its STORED entries, unflattened — mixed levels survive
  registry.runCommand("create_sele @stored");
  assert.deepEqual(commits.at(-1)?.entries,
    [{ level: "subgroup", id: 0 }, { level: "point", id: 2 }]);
  // a union commits each term at its own level (mixed-level member list)
  registry.runCommand("create_sele c1 + #0");
  assert.deepEqual(commits.at(-1)?.entries,
    [{ level: "category", id: 1 }, { level: "point", id: 0 }]);
});

test("create_sele [name] is verbatim; collisions error; empty target commits nothing", () => {
  const { registry, commits } = makeRegistry();
  const res = registry.runCommand("create_sele c0 [a+b.c #5]");
  assert.equal(res.status, "ok");
  assert.equal(res.message, `created "a+b.c #5" — 2 points`);
  assert.equal(commits.at(-1)?.name, "a+b.c #5");
  const clash = registry.runCommand("create_sele c0 [taken]");
  assert.equal(clash.status, "error");
  assert.match(clash.message, /a selection named "taken" already exists/);
  const before = commits.length;
  const miss = registry.runCommand("create_sele zzz");
  assert.equal(miss.status, "nomatch");
  assert.equal(commits.length, before, "no commit on an empty target");
  assert.match((registry.runCommand("create_sele c0 []")).message, /empty selection name/);
  assert.match((registry.runCommand("create_sele c[0]x")).message, /reserved character "\["/);
  assert.ok(registry.verbs().includes("create_sele"), "registered like any verb");
});

test("hide: commit-then-hide for plain targets, whole/member for @name, errors", () => {
  const { registry, commits } = makeRegistry();
  assert.match(registry.runCommand("hide").message, /hide needs a target/);
  assert.equal(registry.runCommand("hide").status, "error");
  // plain target → the create_sele template with hide folded in
  let res = registry.runCommand("hide c0");
  assert.equal(res.message, `created and hid "selection_1" — 2 points`);
  assert.deepEqual(commits.at(-1),
    { entries: [{ level: "category", id: 0 }], name: null, hide: true });
  res = registry.runCommand("hide c1 [dark]");
  assert.equal(res.message, `created and hid "dark" — 1 points`);
  assert.equal(commits.at(-1)?.hide, true);
  assert.match(registry.runCommand("hide c0 [taken]").message, /already exists/);
  // @name → whole-selection flag; NEVER toggles (idempotent ok).
  // "stored" = subgroup:0 (points 0,1) + point:2 → 3 points.
  res = registry.runCommand("hide @stored");
  assert.deepEqual(res, { status: "ok", message: `hid "stored" — 3 points` });
  assert.deepEqual(registry.runCommand("hide @stored"),
    { status: "ok", message: `"stored" is already hidden` });
  // @name.<pred> → MEMBERSHIP-ONLY (reversed): the filter sees the stored
  // entries — subgroup:0 (label "s0") and point:2 (type "c") — never the
  // ancestry of points beneath the coarse member
  res = registry.runCommand("hide @stored.c"); // a point MEMBER's type
  assert.deepEqual(res, { status: "ok", message: `hid 1 points in "stored"` });
  assert.match(registry.runCommand("hide @stored.c").message, /already hidden — 1 members/);
  res = registry.runCommand("hide @stored.s0"); // a label MEMBER — whole-member hide
  assert.deepEqual(res, { status: "ok", message: `hid 2 points in "stored"` });
  assert.equal(registry.runCommand("hide @stored.a").status, "nomatch",
    "a type INSIDE the coarse member is not a member — nomatch");
  assert.equal(registry.runCommand("hide @stored.#0").status, "nomatch",
    "an index inside a coarse member is not a member — nomatch, no exception");
  // usage errors and empty matches
  assert.match(registry.runCommand("hide @stored [x]").message,
    /applies only when hide commits/);
  assert.equal(registry.runCommand("hide @nope").status, "nomatch");
  assert.equal(registry.runCommand("hide zzz").status, "nomatch");
  assert.equal(commits.length, 2, "nomatch/errors committed nothing further");
});

test("show: never commits — clears whole/member/covering state, honest no-ops", () => {
  const { registry, commits } = makeRegistry();
  // nothing hidden yet: bare show and path-show no-op honestly
  assert.deepEqual(registry.runCommand("show"), { status: "ok", message: "nothing hidden" });
  assert.match(registry.runCommand("show c0").message, /nothing hidden there — 2 points already visible/);
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `"stored" is already visible` });
  // hide, then show inverts each granularity
  registry.runCommand("hide @stored");
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `showed "stored" — 3 points` });
  registry.runCommand("hide @stored.c"); // hides the point MEMBER 2
  assert.deepEqual(registry.runCommand("show @stored.c"),
    { status: "ok", message: `showed 1 points in "stored"` });
  assert.deepEqual(registry.runCommand("show @stored.c"),
    { status: "ok", message: `nothing hidden there` });
  assert.equal(registry.runCommand("show @stored.a").status, "nomatch",
    "descendant tokens nomatch on show too — the filter is membership-only");
  // bare show clears everything, in one call
  registry.runCommand("hide @stored");
  registry.runCommand("hide @stored.c");
  assert.match(registry.runCommand("show").message, /showed everything — \d+ points/);
  // show never commits and rejects [name]
  assert.match(registry.runCommand("show c0 [x]").message, /show takes no \[name\]/);
  assert.equal(registry.runCommand("show zzz").status, "nomatch");
  assert.equal(registry.runCommand("show @nope").status, "nomatch");
  assert.equal(commits.length, 0, "show committed nothing, ever");
  assert.ok(registry.verbs().includes("hide") && registry.verbs().includes("show"));
});

test("show @name clears whole AND member state; subset shows explain a whole-flag hide", () => {
  const { registry } = makeRegistry();
  // member hides no longer hide behind "already visible"
  registry.runCommand("hide @stored.c");
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `showed "stored" — 1 points` });
  // a MEMBER show against a WHOLE-hidden selection says so, honestly
  registry.runCommand("hide @stored");
  assert.match(registry.runCommand("show @stored.c").message,
    /hidden whole — show @stored to reveal it/);
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `showed "stored" — 3 points` });
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `"stored" is already visible` });
});

// -- hide's commit rule (consistency principle 3) ------------------------------------

test("hide: an ALL-REFERENCE target hides in place — no commit, ONE batch (one undo)", () => {
  const { registry, commits, refOps, hiddenState } = makeRegistry();
  const res = registry.runCommand("hide @stored + @second");
  assert.deepEqual(res, { status: "ok", message: "hid 4 points across 2 selections" });
  assert.equal(commits.length, 0, "already committed — nothing new created");
  assert.deepEqual(refOps, [{ names: ["stored", "second"], hidden: true }],
    "one setRefsHidden batch = one stroke = one undo");
  assert.equal(hiddenState.whole.get("stored"), true);
  assert.equal(hiddenState.whole.get("second"), true);
  assert.deepEqual(registry.runCommand("hide @stored + @second"),
    { status: "ok", message: "already hidden" }, "idempotent, never toggles");
  assert.match(registry.runCommand("hide @stored + @second [x]").message,
    /applies only when hide commits/, "[name] is a usage error on a committed target");
  assert.equal(commits.length, 0);
});

test("hide @all: every committed selection, in place, one batch", () => {
  const { registry, commits, refOps } = makeRegistry();
  const res = registry.runCommand("hide @all");
  assert.deepEqual(res, { status: "ok", message: "hid 4 points across 2 selections" });
  assert.equal(commits.length, 0);
  assert.deepEqual(refOps, [{ names: ["stored", "second"], hidden: true }]);
  assert.match(registry.runCommand("hide @all [z]").message, /applies only when hide commits/);
});

test("hide with ANY non-reference term: the whole target commits as ONE new selection", () => {
  const { registry, commits, hiddenState } = makeRegistry();
  const res = registry.runCommand("hide @stored + c1");
  assert.equal(res.message, `created and hid "selection_1" — 3 points`);
  assert.equal(commits.length, 1, "all-or-nothing: exactly one commit for the whole target");
  assert.equal(commits[0].hide, true);
  assert.deepEqual(
    commits[0].entries.map((e) => `${e.level}:${e.id}`).sort(),
    ["category:1", "point:2", "subgroup:0"],
    "the referenced selection CONTRIBUTES entries but stays untouched",
  );
  assert.notEqual(hiddenState.whole.get("stored"), true, "show-wins handles the overlap");
  // `hide all` — the everything KEYWORD is not a reference: commit + honest size
  const all = registry.runCommand("hide all");
  assert.equal(all.message, `created and hid "selection_1" — 3 points`);
  assert.equal(commits.length, 2);
  assert.deepEqual(
    commits[1].entries.map((e) => `${e.level}:${e.id}`).sort(),
    ["category:0", "category:1"],
  );
});

test("hide @name.<pred> + @other: still all-references — in place at member grain", () => {
  const { registry, commits, hiddenState } = makeRegistry();
  const res = registry.runCommand("hide @stored.c + @second");
  assert.deepEqual(res, { status: "ok", message: "hid 2 points across 2 selections" });
  assert.equal(commits.length, 0);
  assert.ok(hiddenState.members.has("point:2"), "the filtered MEMBER hid");
  assert.equal(hiddenState.whole.get("second"), true);
  assert.notEqual(hiddenState.whole.get("stored"), true, "not the whole selection");
});

// -- the neighbourhood flags: ?within / ?keep / ?frame ------------------------------
// Fixture geometry (POSITIONS): p0 (subgroup 0) at the origin, p1 (subgroup 0)
// at x=1, p2 (subgroup 1) at x=2. So from p0: nothing outside subgroup 0 within
// 1.9, and subgroup 1 within 2.1.

test("?within: NO flag block is the legacy path, byte-identical and query-free", () => {
  // The whole promise of an optional flag: a command that does not type one
  // must not change, and must not pay for the index.
  const { registry, commits, neighborhoodCalls } = makeRegistry();
  assert.deepEqual(registry.runCommand("create_sele c0.g0.s0"),
    { status: "ok", message: 'created "selection_1" — 2 points' });
  assert.deepEqual(registry.runCommand("hide c0.g0.s0"),
    { status: "ok", message: 'created and hid "selection_1" — 2 points' });
  assert.equal(neighborhoodCalls.length, 0, "no ?block typed → the query never ran");
  assert.equal(commits.length, 2);
});

test("?within ?keep=true: grows the target to WHOLE subgroups, and REPORTS the frame it used", () => {
  const { registry, commits, neighborhoodCalls } = makeRegistry();
  // ?keep=true is EXPLICIT here: the default is false ("around it, not it" — the
  // flag's own name asks for the neighbourhood), so keeping the target is the
  // opt-in and this test is about that shape.
  const r = registry.runCommand("create_sele #0 ?within=2.1 ?keep=true");
  assert.equal(r.status, "ok");
  assert.equal(r.message,
    'created "selection_1" — 2 points (1 subgroup within 2.1 of 1 target point, raw coordinates at frame 0)');
  // measured from the target's points, at the displayed frame
  assert.deepEqual(neighborhoodCalls, [{ points: [0], radius: 2.1, frame: 0 }]);
  // the kept target entry at its natural level, plus the neighbour at SUBGROUP level
  assert.deepEqual(commits[0].entries, [{ level: "point", id: 0 }, { level: "subgroup", id: 1 }]);
});

test("?within: a radius that reaches nothing is an honest nomatch, not an empty ok", () => {
  const { registry, commits } = makeRegistry();
  const r = registry.runCommand("create_sele #0 ?within=1.9 ?keep=false");
  assert.equal(r.status, "nomatch");
  assert.match(r.message, /^nothing within 1\.9 of "#0"/);
  assert.equal(commits.length, 0, "nothing committed");
});

test("?keep DEFAULTS to false — the flag asks for the neighbourhood, not the target", () => {
  // The default was flipped from true after the owner specified this feature as
  // "around a selection INSTEAD of it directly". Pinned because a default is
  // exactly the kind of thing that drifts silently, and because the DOMAIN-tier
  // mods (hide_res/show_res/licorice) carry the same default — one flag name with
  // two defaults is the ambiguity this whole design set out to remove.
  const { registry, commits } = makeRegistry();
  const bare = registry.runCommand("create_sele #0 ?within=2.1");
  const explicit = registry.runCommand("create_sele #0 ?within=2.1 ?keep=false");
  assert.equal(bare.status, "ok");
  assert.equal(explicit.status, "ok");
  assert.deepEqual(commits[0].entries, commits[1].entries,
    "bare ?within must behave exactly as ?keep=false");
  assert.deepEqual(commits[0].entries, [{ level: "subgroup", id: 1 }],
    "the target's own subgroup is NOT in the result");
});

test("?keep=false drops the target at SUBGROUP grain — and says so", () => {
  const { registry, commits } = makeRegistry();
  const r = registry.runCommand("create_sele #0 ?within=2.1 ?keep=false");
  assert.equal(r.status, "ok");
  // p1 shares subgroup 0 with the target p0, so dropping the target drops p1
  // too. That is the surprising part, so it is in the message.
  assert.match(r.message, /the target's own 1 subgroup excluded whole/);
  assert.deepEqual(commits[0].entries, [{ level: "subgroup", id: 1 }],
    "only the neighbour subgroup — the target's own subgroup is gone entirely");
});

test("?within on hide: commits the neighbourhood and hides it in ONE op", () => {
  const { registry, commits } = makeRegistry();
  const r = registry.runCommand("hide #0 ?within=2.1 ?keep=true");
  assert.equal(r.status, "ok");
  assert.match(r.message, /^created and hid "selection_1" — 2 points \(1 subgroup within 2\.1 /);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].hide, true, "commit-then-hide, one stroke, as without the flag");
});

test("hide @name ?within=: REFUSED — hide never commits an all-reference target", () => {
  const { registry, commits, refOps } = makeRegistry();
  const r = registry.runCommand("hide @stored ?within=2.1");
  assert.equal(r.status, "error");
  assert.match(r.message, /must COMMIT what it finds/);
  assert.match(r.message, /create_sele @stored \?within=2\.1 \[neighbourhood\] then hide @neighbourhood/,
    "the refusal names the two-step that works");
  assert.equal(commits.length, 0, "nothing committed");
  assert.equal(refOps.length, 0, "and nothing hidden");
  // create_sele has no such invariant — it always commits, so the flag is fine
  assert.equal(registry.runCommand("create_sele @stored ?within=2.1 ?keep=true").status, "ok");
});

test("?within is REQUIRED once the block is typed — no default radius, ever", () => {
  const { registry, commits } = makeRegistry();
  for (const cmd of ["create_sele #0 ?keep=false", "hide #0 ?frame=0"]) {
    const r = registry.runCommand(cmd);
    assert.equal(r.status, "error", cmd);
    assert.match(r.message, /missing required parameter "within" \(number\)/, cmd);
  }
  assert.equal(commits.length, 0);
});

test("?frame: current by default, an explicit frame is range-checked", () => {
  const { registry, neighborhoodCalls } = makeRegistry();
  assert.equal(registry.runCommand("create_sele #0 ?within=2.1 ?frame=current").status, "ok");
  assert.equal(neighborhoodCalls.at(-1)!.frame, 0);
  assert.equal(registry.runCommand("create_sele #0 ?within=2.1 ?frame=0").status, "ok");
  assert.equal(neighborhoodCalls.at(-1)!.frame, 0);
  // the fixture has ONE frame, so frame 1 is out of range and must not query
  const before = neighborhoodCalls.length;
  const oob = registry.runCommand("create_sele #0 ?within=2.1 ?frame=7");
  assert.equal(oob.status, "error");
  assert.match(oob.message, /frame 7 is out of range — this dataset has 1 frame \(0\.\.0\)/);
  assert.equal(neighborhoodCalls.length, before, "an out-of-range frame never reaches the query");
  // and a word that is neither "current" nor a number
  assert.match(registry.runCommand("create_sele #0 ?within=2.1 ?frame=last").message,
    /\?frame= takes "current" or a frame number — got "last"/);
});

test("neighbourhood flags fail closed: bad names, bad types, negative radius", () => {
  const { registry, commits } = makeRegistry();
  const cases: [string, RegExp][] = [
    ["create_sele #0 ?within=-1", /\?within= must not be negative — got -1/],
    ["create_sele #0 ?within=near", /parameter "within" expects a number/],
    ["create_sele #0 ?within=2 ?keep=yes", /parameter "keep" expects true or false/],
    ["create_sele #0 ?within=2 ?radius=3", /unknown parameter "radius" \(declared: within, keep, frame\)/],
    ["create_sele #0 ?within=2 ?within=3", /parameter "within" given twice/],
    ["create_sele #0 ?", /empty parameter — each is \?key=value/],
    ["create_sele #0 ?within", /parameter "within" must be key=value/],
    ['create_sele #0 ?within="2', /unbalanced '"' in the invocation/],
  ];
  for (const [cmd, re] of cases) {
    const r = registry.runCommand(cmd);
    assert.equal(r.status, "error", cmd);
    assert.match(r.message, re, cmd);
  }
  assert.equal(commits.length, 0, "not one of these wrote anything");
});

test("the flag block comes LAST — after [name], as bake/bind's ?option does", () => {
  const { registry, commits } = makeRegistry();
  // `<target> [name] ?flags` is the supported order (the ? split runs first)
  const r = registry.runCommand("create_sele #0 [near] ?within=2.1");
  assert.equal(r.status, "ok");
  assert.equal(commits[0].name, "near");
  // and the other order blames the ORDER, not the type. Left alone this
  // surfaces as `parameter "within" expects a number, got "2.1 [near]"` —
  // technically true and useless, the same trap bake/bind's must-come-LAST
  // refusal was written for.
  const wrong = registry.runCommand("create_sele #0 ?within=2.1 [near]");
  assert.equal(wrong.status, "error", "the name must not migrate into the value");
  assert.match(wrong.message, /the \?flag block must come LAST — a \[name\] after it is read as part of a flag's value/);
  assert.doesNotMatch(wrong.message, /expects a number/, "never blame the type for an order mistake");
  assert.equal(commits.length, 1, "only the correct order committed");
});

test("?within completes its flag names and the boolean's values", () => {
  const { registry, ctx } = makeRegistry();
  const comp = (text: string) => completeCommand(ctx, registry, text, text.length);
  // flag NAMES come from the declaration, not a hand-copied list
  assert.deepEqual(comp("create_sele #0 ?").candidates, ["frame", "keep", "within"]);
  assert.deepEqual(comp("hide #0 ?").candidates, ["frame", "keep", "within"]);
  assert.deepEqual(comp("create_sele #0 ?k").candidates, ["keep"]);
  // `applied` is the text appended to what was typed, so "?k" + "eep=" — a
  // unique flag name settles straight into its value slot
  assert.equal(comp("create_sele #0 ?k").applied, "eep=");
  // an already-used flag drops out of the pool (resolveParameters' rule, mirrored)
  assert.deepEqual(comp("create_sele #0 ?within=2 ?").candidates, ["frame", "keep"]);
  // the boolean enumerates; the required number has no default so it offers nothing
  assert.deepEqual(comp("create_sele #0 ?keep=").candidates, ["false", "true"]);
  assert.deepEqual(comp("create_sele #0 ?within=").candidates, []);
  // with no unquoted ? typed, the target slot is untouched
  assert.deepEqual(comp("create_sele c0.").candidates, comp("view c0.").candidates);
});

test("?frame is a `hint`: it SUGGESTS 'current' and still takes any frame index", () => {
  // THE REAL CONSUMER. `?frame=` takes the literal `current` or a frame index —
  // the shape neither `choice` (which would refuse every index) nor `number`
  // (which can neither express nor complete the literal) can state. As a
  // `string` it completed NOTHING, so the literal was undiscoverable from the
  // terminal; as a `hint` the literal is offered and the index still runs.
  const { registry, ctx, neighborhoodCalls } = makeRegistry();
  const comp = (text: string) => completeCommand(ctx, registry, text, text.length);

  // COMPLETION: the literal is offered, on both verbs that carry the block,
  // and it is labelled a SUGGESTION (not an exhaustive value list)
  for (const verb of ["create_sele", "hide"]) {
    const c = comp(`${verb} #0 ?frame=`);
    assert.deepEqual(c.candidates, ["current"], verb);
    assert.equal(c.kind, "suggestion", `${verb}: the list is advisory, and says so`);
    // a unique suggestion settles like every other slot — the ONE shared path
    assert.equal(c.applied, "current", verb);
    assert.deepEqual(comp(`${verb} #0 ?frame=cur`).applied, "rent", verb);
  }
  // a value outside the suggestion completes nothing — never a guess
  assert.deepEqual(comp("create_sele #0 ?frame=0").candidates, []);
  // the flag NAME pool is unchanged (the type moved, the schema did not)
  assert.deepEqual(comp("create_sele #0 ?").candidates, ["frame", "keep", "within"]);

  // RUNTIME, unchanged: the suggestion restricts nothing. An index still runs,
  // and the domain rule stays where live state is known (splitTargetNameFlags).
  assert.equal(registry.runCommand("create_sele #0 ?within=2.1 ?frame=0").status, "ok");
  assert.equal(neighborhoodCalls.at(-1)!.frame, 0);
  assert.equal(registry.runCommand("create_sele #0 ?within=2.1 ?frame=current").status, "ok");
  // ...and an out-of-domain word is still REFUSED there, with the same wording
  assert.match(registry.runCommand("create_sele #0 ?within=2.1 ?frame=last").message,
    /\?frame= takes "current" or a frame number — got "last"/);
});

test("a macro pre-validates ?within WITHOUT running the query twice", () => {
  // runCommandMacro validates EVERY string before executing ANY. The
  // neighbourhood query is the one genuinely expensive read on the context, so
  // a validation pass must stub it — otherwise every macro command pays for
  // its radius search twice. This pins the wiring main.ts does (the
  // validationContext's `neighborhoodSubgroups: () => []`).
  const real = makeRegistry();
  const validation = makeRegistry();
  // the validation context's stub: no query, no cost — main.ts's override
  const validationCtx: CommandContext = { ...validation.ctx, neighborhoodSubgroups: () => [] };
  const validationRegistry = createCommandRegistry(validationCtx);

  const cmds = ["create_sele #0 [a] ?within=2.1", "create_sele #1 [b] ?within=2.1"];
  const out = runCommandMacro("m", cmds, {
    modNames: new Set<string>(),
    validate: (c) => validationRegistry.runCommand(c),
    run: (c) => real.registry.runCommand(c),
    beginStroke: () => {},
    endStroke: () => {},
  });
  assert.equal(out.status, "ok", out.message);
  assert.equal(real.neighborhoodCalls.length, 2, "the real query ran ONCE per command");
  assert.equal(validation.neighborhoodCalls.length, 0,
    "and the validation pass ran it ZERO times — this fails if the stub is dropped");
});

// -- ls / rename / clear -------------------------------------------------------------

test("ls: read-only listing — selections, members, contents; no state, ever", () => {
  const { registry, commits, refOps } = makeRegistry();
  // bare = the committed selections (the panel's top section as text)
  assert.deepEqual(registry.runCommand("ls"),
    { status: "ok", message: "stored — 3 points\nsecond — 1 points" });
  // @name = its STORED MEMBERS, exactly as the panel lists them
  assert.deepEqual(registry.runCommand("ls @stored"),
    { status: "ok", message: "s0 — 2 points\nc #2 — 1 points" });
  assert.deepEqual(registry.runCommand("ls @all"),
    { status: "ok", message: "s0 — 2 points\nc #2 — 1 points\ns1 — 1 points" });
  // <path> = the contents ONE level below the resolved nodes
  assert.deepEqual(registry.runCommand("ls c0"), { status: "ok", message: "g0 — 2 points" });
  assert.deepEqual(registry.runCommand("ls c0.g0"), { status: "ok", message: "s0 — 2 points" });
  assert.deepEqual(registry.runCommand("ls c0.g0.s0"),
    { status: "ok", message: "a #0 — 1 points\nb #1 — 1 points" });
  assert.equal(registry.runCommand("ls c1.g1.s1.c").message,
    "nothing below — points have no contents");
  // the hidden flag surfaces in the bare listing
  registry.runCommand("hide @second");
  assert.match(registry.runCommand("ls").message, /second — 1 points · hidden/);
  // guards: no [name]; honest nomatch
  assert.match(registry.runCommand("ls c0 [x]").message, /ls takes no \[name\]/);
  assert.equal(registry.runCommand("ls @nope").status, "nomatch");
  assert.equal(registry.runCommand("ls zzz").status, "nomatch");
  assert.equal(commits.length, 0, "ls committed nothing");
  assert.equal(refOps.length, 1, "only the explicit hide touched state");
  assert.ok(registry.verbs().includes("ls"));
});

test("rename: exactly one @name, bracketed new name, model-routed collision/reserve", () => {
  const { registry, sels } = makeRegistry();
  assert.deepEqual(registry.runCommand("rename @stored [best]"),
    { status: "ok", message: `renamed "stored" → "best"` });
  assert.ok(sels.has("best") && !sels.has("stored"), "routed through the model's rename");
  assert.match(registry.runCommand("rename @best [second]").message,
    /a selection named "second" already exists/);
  assert.match(registry.runCommand("rename @best [all]").message, /reserved/);
  assert.match(registry.runCommand("rename @best").message, /needs a bracketed name/);
  for (const bad of ["rename @best + @second [x]", "rename @best.c [x]",
    "rename c0 [x]", "rename @all [x]"]) {
    assert.match(registry.runCommand(bad).message, /exactly one committed selection/, bad);
  }
  assert.equal(registry.runCommand("rename @nope [x]").status, "nomatch");
  assert.ok(sels.has("best") && sels.has("second"), "failed renames changed nothing");
});

test("clear is a registered verb (the terminal surface intercepts it locally)", () => {
  const { registry, commits, refOps } = makeRegistry();
  assert.ok(registry.verbs().includes("clear"));
  assert.equal(registry.runCommand("clear").status, "ok");
  assert.match(registry.runCommand("help clear").message, /terminal/);
  assert.equal(commits.length + refOps.length, 0, "clear never reaches viewer state");
});

// -- add / remove: membership mutation (whole-member granularity, no carve) -----------

test("add: tree-addressed entries join as members at their NATURAL level", () => {
  const { registry, sels } = makeRegistry();
  // a group-level address adds ONE group entry, never its points
  let res = registry.runCommand("add @second c0.g0");
  assert.deepEqual(res, { status: "ok", message: `added 1 members to "second" — 2 points` });
  assert.deepEqual(sels.get("second"),
    [{ level: "subgroup", id: 1 }, { level: "group", id: 0 }]);
  // a point-level address adds point members
  res = registry.runCommand("add @second c1.g1.s1.c");
  assert.equal(res.status, "ok");
  assert.ok(sels.get("second")!.some((e) => e.level === "point" && e.id === 2));
  // multi-term: both sides of the + join in one command
  const { registry: r2, sels: s2 } = makeRegistry();
  res = r2.runCommand("add @second c0.g0 + c1.g1.s1.c");
  assert.equal(res.message, `added 2 members to "second" — 3 points`);
  assert.equal(s2.get("second")!.length, 3);
});

test("add: idempotent at the entry level — exact members are never duplicated", () => {
  const { registry, sels, memberOps } = makeRegistry();
  // subgroup:0 is already a stored member of "stored"
  let res = registry.runCommand("add @stored c0.g0.s0");
  assert.deepEqual(res, { status: "ok", message: `already members — nothing to add to "stored"` });
  assert.equal(sels.get("stored")!.length, 2, "no mutation");
  assert.equal(memberOps.length, 0, "the mutator was never called");
  // mixed: only the fresh entry goes through
  res = registry.runCommand("add @stored c0.g0.s0 + c0.g0");
  assert.equal(res.message, `added 1 members to "stored" — 2 points`);
  assert.deepEqual(memberOps.at(-1)?.entries, [{ level: "group", id: 0 }]);
});

test("add: usage errors — one lone @name on the left, tree-only on the right", () => {
  const { registry, memberOps } = makeRegistry();
  assert.match(registry.runCommand("add @stored @second").message,
    /add takes TREE addresses .*no @ terms on the right/);
  assert.match(registry.runCommand("add @stored @all").message, /no @ terms on the right/);
  assert.match(registry.runCommand("add @stored + @second c0").message,
    /ONE selection at a time/);
  assert.match(registry.runCommand("add @all c0").message,
    /@all is not a single selection/);
  assert.match(registry.runCommand("add c0 @stored").message,
    /needs a committed selection first/);
  assert.match(registry.runCommand("add @stored.c c0").message, /no filter/);
  assert.match(registry.runCommand("add @stored").message, /needs something to add/);
  assert.match(registry.runCommand("add @stored c0 [x]").message, /takes no \[name\]/);
  assert.equal(registry.runCommand("add @nope c0").status, "nomatch");
  assert.equal(registry.runCommand("add @stored zzz").status, "nomatch");
  assert.equal(memberOps.length, 0, "no error path mutated anything");
});

test("remove <member-pred>: drops matched STORED members via the @name.<pred> matcher", () => {
  const { registry, sels } = makeRegistry();
  // a member's own label
  let res = registry.runCommand("remove @stored s0");
  assert.deepEqual(res, { status: "ok", message: `removed 1 members from "stored" — 2 points` });
  assert.deepEqual(sels.get("stored"), [{ level: "point", id: 2 }]);
  // a point member's type; the LAST member leaves the selection standing
  res = registry.runCommand("remove @stored c");
  assert.equal(res.message,
    `removed 1 members from "stored" — 1 points (now empty — the selection remains)`);
  assert.ok(sels.has("stored"), "emptied, NOT deleted");
  assert.equal(sels.get("stored")!.length, 0);
  // multi-term union in one command
  const { registry: r2, sels: s2 } = makeRegistry();
  res = r2.runCommand("remove @stored s0 + #2");
  assert.match(res.message, /removed 2 members .*now empty/);
  assert.ok(s2.has("stored"));
});

test("remove: a predicate below a coarse member NOMATCHES — carving is impossible", () => {
  const { registry, sels, memberOps } = makeRegistry();
  // "a" is the TYPE of point 0 INSIDE stored's coarse member s0 — not a member
  assert.equal(registry.runCommand("remove @stored a").status, "nomatch");
  assert.equal(registry.runCommand("remove @stored #0").status, "nomatch",
    "an index inside the coarse member is not a member");
  assert.equal(registry.runCommand("remove @stored g0").status, "nomatch",
    "an ancestor label is not a member");
  assert.equal(sels.get("stored")!.length, 2, "member list untouched — no complement materialized");
  assert.equal(memberOps.length, 0);
  // paths are rejected outright: members are named by their OWN label
  assert.match(registry.runCommand("remove @stored c0.g0").message,
    /OWN members .* no paths/s);
});

test("remove @name all: empties the membership — the selection REMAINS", () => {
  const { registry, sels } = makeRegistry();
  const res = registry.runCommand("remove @stored all");
  assert.equal(res.message,
    `removed 2 members from "stored" — 3 points (now empty — the selection remains)`);
  assert.ok(sels.has("stored"), "all empties; it never deletes");
  assert.equal(sels.get("stored")!.length, 0);
  assert.ok(sels.has("second"), "other selections untouched");
});

test("bare remove @name: DELETES the selection (the panel's ✕)", () => {
  const { registry, sels } = makeRegistry();
  const res = registry.runCommand("remove @second");
  assert.deepEqual(res, { status: "ok", message: `deleted "second" — 1 points` });
  assert.ok(!sels.has("second"), "gone from the committed list");
  assert.deepEqual(sels.get("stored")!.length, 2, "the other selection untouched");
  assert.equal(registry.runCommand("remove @second").status, "nomatch");
});

test("remove @all: deletes EVERY committed selection (the one bulk delete)", () => {
  const { registry, sels } = makeRegistry();
  const res = registry.runCommand("remove @all");
  assert.deepEqual(res, { status: "ok", message: `deleted 2 selections — 3 points` });
  assert.equal(sels.size, 0);
  assert.equal(registry.runCommand("remove @all").status, "nomatch");
  // @all with a second argument is a usage error, not a member form
  const { registry: r2 } = makeRegistry();
  assert.match(r2.runCommand("remove @all s0").message,
    /remove @all takes no second argument/);
});

test("remove: left-side guards match add's — one @name, no unions, no filter", () => {
  const { registry, sels } = makeRegistry();
  assert.match(registry.runCommand("remove @stored + @second").message,
    /ONE selection at a time/);
  assert.match(registry.runCommand("remove @stored.c s0").message, /no filter/);
  assert.match(registry.runCommand("remove c0 s0").message, /needs a committed selection first/);
  assert.match(registry.runCommand("remove @stored s0 [x]").message, /takes no \[name\]/);
  assert.equal(registry.runCommand("remove @nope s0").status, "nomatch");
  assert.equal(sels.size, 2, "nothing deleted by the error paths");
  assert.ok(registry.verbs().includes("add") && registry.verbs().includes("remove"));
});

test("view still dispatches through the same registry (bare view = frameVisible)", () => {
  const { registry, calls } = makeRegistry();
  const res = registry.runCommand("view");
  assert.equal(res.status, "ok");
  assert.equal(calls.frame, 1);
  const res2 = registry.runCommand("view c0");
  assert.equal(res2.message, "focused 2 points");
  assert.equal(calls.focus, 1);
  assert.equal(calls.flash, 1);
});

// -- the color family: colorpoints / colorbonds / colorbondsof -----------------------

test("parseColor: CSS names, hex long/short, case-insensitive; junk is null", () => {
  assert.deepEqual(parseColor("red"), [1, 0, 0]);
  assert.deepEqual(parseColor("black"), [0, 0, 0]);
  assert.deepEqual(parseColor("white"), [1, 1, 1]);
  assert.deepEqual(parseColor("steelblue"), [0x46 / 255, 0x82 / 255, 0xb4 / 255]);
  assert.deepEqual(parseColor("#ff8800"), [1, 0x88 / 255, 0]);
  assert.deepEqual(parseColor("#f80"), parseColor("#ff8800"), "#rgb expands to #rrggbb");
  assert.deepEqual(parseColor("Red"), parseColor("red"), "CSS names are case-insensitive");
  assert.deepEqual(parseColor("#FF8800"), parseColor("#ff8800"));
  for (const junk of ["notacolor", "#ggg", "#12345", "#1234567", "#", "", "rgb(1,2,3)"]) {
    assert.equal(parseColor(junk), null, junk);
  }
});

test("the rename is total: colorpoints is the verb, color is UNKNOWN", () => {
  const { registry, colorOps } = makeRegistry();
  const old = registry.runCommand("color c0 red");
  assert.equal(old.status, "error");
  assert.equal(old.message, "unknown command: color", "no alias — color is gone");
  assert.equal(colorOps.length, 0);
  assert.ok(registry.verbs().includes("colorpoints"));
  assert.ok(!registry.verbs().includes("color"));
});

test("colorpoints resolves EXACTLY like view (same resolver, hidden included), writes once", () => {
  const { registry, colorOps } = makeRegistry();
  // category path → the same 2 points "view c0" focuses (points 0 and 1)
  const res = registry.runCommand("colorpoints c0 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 2 points red");
  assert.equal(colorOps.length, 1, "one invocation = one write (one stroke)");
  assert.deepEqual(colorOps[0].points, [0, 1]);
  assert.deepEqual(colorOps[0].rgb, [1, 0, 0]);
  // full grammar: leaf type, @name (stored members), all, hex color
  assert.equal(registry.runCommand("colorpoints c0.g0.s0.a #ff8800").message, "colored 1 points #ff8800");
  assert.deepEqual(colorOps[1].points, [0]);
  assert.equal(registry.runCommand("colorpoints @stored steelblue").status, "ok");
  assert.deepEqual(colorOps[2].points, [0, 1, 2], "@stored = subgroup s0 (0,1) + point 2");
  assert.equal(registry.runCommand("colorpoints all white").message, "colored 3 points white");
});

test("colorpoints: re-coloring an overlap is simply a NEW write (LWW downstream)", () => {
  const { registry, colorOps } = makeRegistry();
  registry.runCommand("colorpoints c0 red");
  registry.runCommand("colorpoints c0.g0.s0.a blue");
  assert.equal(colorOps.length, 2, "two invocations, two strokes — no merge, no precedence");
  assert.deepEqual(colorOps[1].points, [0]);
  assert.deepEqual(colorOps[1].rgb, [0, 0, 1]);
});

test("colorbonds: BOTH endpoints in the set (contained) — same resolver as view", () => {
  const { registry, edgeOps, colorOps } = makeRegistry();
  // c0 = {0,1}: edge 0 (0,1) contained; edge 1 (1,2) leaks out → excluded
  const res = registry.runCommand("colorbonds c0 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 1 edges red");
  assert.deepEqual(edgeOps[0], { edgeIds: [0], rgb: [1, 0, 0] });
  // all = {0,1,2}: both edges contained
  assert.equal(registry.runCommand("colorbonds all #f80").message, "colored 2 edges #f80");
  assert.deepEqual(edgeOps[1].edgeIds, [0, 1]);
  assert.equal(colorOps.length, 0, "the POINT buffer is never touched (independence)");
});

test("colorbondsof: AT LEAST ONE endpoint (incident) — reaches one hop outside", () => {
  const { registry, edgeOps } = makeRegistry();
  // c0 = {0,1}: edge 1 (1,2) has its OTHER endpoint outside c0 and is colored
  // anyway — the incident reach is the verb's contract, not a bug
  const res = registry.runCommand("colorbondsof c0 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 2 edges red");
  assert.deepEqual(edgeOps[0].edgeIds, [0, 1]);
});

test("single-point target pins contained-vs-incident: bonds nomatch, bondsof incident", () => {
  const { registry, edgeOps } = makeRegistry();
  // c0.g0.s0.a = point {0}: no edge has both endpoints in a one-point set
  const bonds = registry.runCommand("colorbonds c0.g0.s0.a red");
  assert.equal(bonds.status, "nomatch");
  assert.equal(bonds.message, `no edges with both endpoints in "c0.g0.s0.a"`);
  assert.equal(edgeOps.length, 0, "a no-edge nomatch writes nothing");
  // …but exactly the edges incident to that point color under colorbondsof
  const bondsof = registry.runCommand("colorbondsof c0.g0.s0.a red");
  assert.equal(bondsof.status, "ok");
  assert.equal(bondsof.message, "colored 1 edges red");
  assert.deepEqual(edgeOps[0].edgeIds, [0]);
});

test("a LONE value targets everything — the target is optional on the rep verbs", () => {
  // `traceopacity 0.1` == `traceopacity all 0.1`. One rule, one seam
  // (splitAndParseValue), so the whole point/edge/trace grid gets it at once —
  // which is also why this is asserted across the grid rather than on one verb.
  const fx = makeRegistry();
  // TOTAL across every write sink, so this asserts "it wrote" without encoding
  // which sink each verb happens to use — that mapping is not what is under test.
  const wrote = () => fx.colorOps.length + fx.colorEachOps.length + fx.eachOps.length +
    fx.edgeOps.length + fx.endsOps.length + fx.traceOps.length + fx.sizeOps.length +
    fx.dashOps.length + fx.opacityOps.length;
  for (const [verb, value] of [
    ["colorpoints", "red"], ["pointopacity", "0.25"], ["pointsize", "2"],
    ["colorbonds", "red"], ["bondopacity", "0.25"],
    ["colortrace", "red"], ["traceopacity", "0.1"],
  ] as Array<[string, string]>) {
    const before = wrote();
    const r = fx.registry.runCommand(`${verb} ${value}`);
    assert.equal(r.status, "ok", `${verb} ${value} → ${r.message}`);
    assert.ok(wrote() > before, `${verb} ${value} must WRITE, not just report ok`);
  }
});

test("a lone token that is NOT a value is still a usage error, not a silent all", () => {
  // The rule is "a lone token that PARSES is the value". Junk must not be taken
  // as a target with a missing value and quietly do nothing, and must not be
  // taken as a value either — it is a usage error naming the shape.
  const fx = makeRegistry();
  const wrote = () => fx.colorOps.length + fx.colorEachOps.length + fx.eachOps.length +
    fx.edgeOps.length + fx.endsOps.length + fx.traceOps.length + fx.sizeOps.length +
    fx.dashOps.length + fx.opacityOps.length;
  const before = wrote();
  // NOT out-of-range numbers: parseSize/parseOpacity CLAMP by design (-1 -> 0,
  // 5 -> 1), so `pointopacity 5` is a legitimate lone value that means "all points,
  // clamped to 1" — exactly as `pointopacity all 5` always has. Junk here means a
  // token that does not parse AT ALL.
  for (const text of ["colorpoints notacolor", "pointopacity abc", "pointsize abc"]) {
    const r = fx.registry.runCommand(text);
    assert.equal(r.status, "error", text);
  }
  assert.equal(wrote(), before, "no lone-junk path wrote anything");
});

test("the edge verbs: nomatch / bad color / usage / parse errors write NOTHING", () => {
  const { registry, edgeOps } = makeRegistry();
  for (const verb of ["colorbonds", "colorbondsof"]) {
    const nomatch = registry.runCommand(`${verb} nothere red`);
    assert.equal(nomatch.status, "nomatch", verb);
    assert.match(nomatch.message, /nothing matches "nothere"/);
    const bad = registry.runCommand(`${verb} c0 notacolor`);
    assert.equal(bad.status, "error", verb);
    assert.match(bad.message, /unknown color "notacolor"/);
    const bare = registry.runCommand(verb);
    assert.equal(bare.status, "error", verb);
    assert.match(bare.message, new RegExp(`${verb} \\[<target>\\] <color>`));
    // a lone token that does NOT parse is still a usage error (the lone-value
    // SUCCESS path lives in its own test — this one is about writes on failure)
    const loneJunk = registry.runCommand(`${verb} notacolor`);
    assert.equal(loneJunk.status, "error", verb);
    assert.match(loneJunk.message, /needs a color/);
    const parseErr = registry.runCommand(`${verb} c0.[x] red`); // [ reserved
    assert.equal(parseErr.status, "error", verb);
  }
  assert.equal(edgeOps.length, 0, "no path wrote anything");
});

// -- the bicolor pair: bicolorbonds / bicolorbondsof (endpoint-color snapshot) -----

test("bicolorbonds: contained edges take their endpoints' CURRENT colors, per half", () => {
  const { registry, endsOps, edgeOps, colorOps } = makeRegistry();
  // c0 = {0,1}: edge 0 (0,1) contained. The snapshot source is the fake
  // point-color buffer: point 0 = [.1,.2,.3] → the A half; point 1 =
  // [.4,.5,.6] → the B half. A half-swap would be loud here.
  const res = registry.runCommand("bicolorbonds c0");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "bicolored 1 edges from their endpoints' colors");
  assert.equal(endsOps.length, 1);
  assert.deepEqual(endsOps[0].ids, [0]);
  assert.deepEqual(endsOps[0].a.map((x) => Math.round(x * 10) / 10), [0.1, 0.2, 0.3]);
  assert.deepEqual(endsOps[0].b.map((x) => Math.round(x * 10) / 10), [0.4, 0.5, 0.6]);
  assert.equal(edgeOps.length + colorOps.length, 0,
    "neither the constant edge writer nor the point buffer is touched");
});

test("bicolorbondsof: the incident reach — the out-of-set endpoint supplies ITS half", () => {
  const { registry, endsOps } = makeRegistry();
  // c1 = {2}: edge 1 (1,2) is incident; point 1 is OUTSIDE the target yet
  // supplies the A half (reading one hop out is the verb's contract).
  const res = registry.runCommand("bicolorbondsof c1");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "bicolored 1 edges from their endpoints' colors");
  assert.deepEqual(endsOps[0].ids, [1]);
  assert.deepEqual(endsOps[0].a.map((x) => Math.round(x * 10) / 10), [0.4, 0.5, 0.6]);
  assert.deepEqual(endsOps[0].b.map((x) => Math.round(x * 10) / 10), [0.7, 0.8, 0.9]);
});

test("bicolorbonds: single-point pin — contained nomatches, incident snapshots", () => {
  const { registry, endsOps } = makeRegistry();
  const bonds = registry.runCommand("bicolorbonds c1");
  assert.equal(bonds.status, "nomatch");
  assert.equal(bonds.message, `no edges with both endpoints in "c1"`);
  assert.equal(endsOps.length, 0, "a no-edge nomatch writes nothing");
  const bondsof = registry.runCommand("bicolorbondsof c0.g0.s0.a");
  assert.equal(bondsof.status, "ok");
  assert.deepEqual(endsOps[0].ids, [0]);
});

test("the bicolor verbs: nomatch / usage / parse / trailing-junk paths write NOTHING", () => {
  const { registry, endsOps } = makeRegistry();
  for (const verb of ["bicolorbonds", "bicolorbondsof"]) {
    const nomatch = registry.runCommand(`${verb} nothere`);
    assert.equal(nomatch.status, "nomatch", verb);
    assert.match(nomatch.message, /nothing matches "nothere"/);
    const bare = registry.runCommand(verb);
    assert.equal(bare.status, "error", verb);
    assert.match(bare.message, new RegExp(`${verb} <target>`));
    const parseErr = registry.runCommand(`${verb} c0.[x]`); // [ reserved
    assert.equal(parseErr.status, "error", verb);
    // NO two-argument color form exists — a trailing color token is target
    // text, and unquoted space-separated terms are a grammar parse error
    // (locked design: snapshot only, never a passed color)
    const withColor = registry.runCommand(`${verb} c0 red`);
    assert.equal(withColor.status, "error", verb);
  }
  assert.equal(endsOps.length, 0, "no path wrote anything");
});

// -- the dash pair: dashbonds / dashbondsof (per-edge solid/dashed) ---------------

test("dashbonds/dashbondsof: the bondsize pair's exact predicates on the dash buffer", () => {
  const { registry, dashOps, sizeOps } = makeRegistry();
  // contained: c0 = {0,1} → edge 0 only
  const bonds = registry.runCommand("dashbonds c0 1.5");
  assert.equal(bonds.status, "ok");
  assert.equal(bonds.message, "set 1 edges to dash 1.5");
  assert.deepEqual(dashOps[0], { ids: [0], dash: 1.5 });
  // incident: edge 1 reaches out of c0
  const bondsof = registry.runCommand("dashbondsof c0 2");
  assert.equal(bondsof.message, "set 2 edges to dash 2");
  assert.deepEqual(dashOps[1].ids, [0, 1]);
  assert.equal(sizeOps.length, 0, "the size buffer is never touched (dash ⊥ size)");
});

test("dashbonds: 0 is SOLID (a literal legal value) and negatives clamp to 0", () => {
  const { registry, dashOps } = makeRegistry();
  const zero = registry.runCommand("dashbonds c0 0");
  assert.equal(zero.status, "ok");
  assert.equal(zero.message, "set 1 edges to dash 0 (solid)");
  assert.deepEqual(dashOps[0], { ids: [0], dash: 0 });
  const neg = registry.runCommand("dashbonds c0 -2");
  assert.equal(neg.message, "set 1 edges to dash 0 (clamped to 0) (solid)");
  assert.deepEqual(dashOps[1], { ids: [0], dash: 0 });
});

test("the dash verbs: nomatch / bad value / usage / parse errors write NOTHING", () => {
  const { registry, dashOps } = makeRegistry();
  for (const verb of ["dashbonds", "dashbondsof"]) {
    const nomatch = registry.runCommand(`${verb} nothere 1`);
    assert.equal(nomatch.status, "nomatch", verb);
    const bad = registry.runCommand(`${verb} c0 notanumber`);
    assert.equal(bad.status, "error", verb);
    assert.match(bad.message, /not a dash scale: "notanumber"/);
    const bare = registry.runCommand(verb);
    assert.equal(bare.status, "error", verb);
    assert.match(bare.message, new RegExp(`${verb} \\[<target>\\] <dash scale>`));
    const parseErr = registry.runCommand(`${verb} c0.[x] 1`);
    assert.equal(parseErr.status, "error", verb);
  }
  // contained pin: a one-point set holds no edge
  const pin = registry.runCommand("dashbonds c0.g0.s0.a 2");
  assert.equal(pin.status, "nomatch");
  assert.equal(pin.message, `no edges with both endpoints in "c0.g0.s0.a"`);
  assert.equal(dashOps.length, 0, "no path wrote anything");
});

test("dash verbs are sealed built-ins with help lines", () => {
  const { registry } = makeRegistry();
  for (const verb of ["dashbonds", "dashbondsof"]) {
    assert.ok(registry.verbs().includes(verb), verb);
    assert.ok(registry.isBuiltin(verb), `${verb} is sealed as a built-in`);
    assert.match(registry.runCommand(`help ${verb}`).message, new RegExp(`^${verb} — `));
  }
  assert.match(HELP_TEXT, /dashbonds <expr> <scale>/);
  assert.match(HELP_TEXT, /dashbondsof <expr> <scale>/);
});

test("bicolor verbs are sealed built-ins with help lines", () => {
  const { registry } = makeRegistry();
  for (const verb of ["bicolorbonds", "bicolorbondsof"]) {
    assert.ok(registry.verbs().includes(verb), verb);
    assert.ok(registry.isBuiltin(verb), `${verb} is sealed as a built-in`);
    assert.match(registry.runCommand(`help ${verb}`).message, new RegExp(`^${verb} — `));
  }
  assert.match(HELP_TEXT, /bicolorbonds <expr>/);
  assert.match(HELP_TEXT, /bicolorbondsof <expr>/);
});

// -- the #e edge-index axis: name edges DIRECTLY by contract edge index -----------

test("#e edge-index: names edges directly (both/incident irrelevant), header order", () => {
  const { registry, edgeOps, dashOps } = makeRegistry();
  // edges are [[0,1],[1,2]] → #e0 = edge 0, #e1 = edge 1, #e0-1 / #e* = both
  assert.equal(registry.runCommand("colorbonds #e0 red").message, "colored 1 edges red");
  assert.deepEqual(edgeOps[0], { edgeIds: [0], rgb: [1, 0, 0] });
  assert.equal(registry.runCommand("colorbonds #e1 blue").message, "colored 1 edges blue");
  assert.deepEqual(edgeOps[1].edgeIds, [1]);
  assert.equal(registry.runCommand("colorbonds #e0-1 green").message, "colored 2 edges green");
  assert.deepEqual(edgeOps[2].edgeIds, [0, 1]);
  assert.equal(registry.runCommand("colorbonds #e* white").message, "colored 2 edges white");
  assert.deepEqual(edgeOps[3].edgeIds, [0, 1]);
  // the `of` variant with a #e target names the SAME edges — you named them
  assert.equal(registry.runCommand("colorbondsof #e0 red").message, "colored 1 edges red");
  assert.deepEqual(edgeOps[4].edgeIds, [0]);
  // dash the AUTHORED edges by index — the increment's motivating use
  assert.equal(registry.runCommand("dashbonds #e1 2").message, "set 1 edges to dash 2");
  assert.deepEqual(dashOps[0], { ids: [1], dash: 2 });
});

test("#e edge-index: out-of-range clamps to nothing (nomatch, the #N rule); malformed errors", () => {
  const { registry, edgeOps } = makeRegistry();
  // #e5 is past the 2 edges → nomatch, nothing written
  const oor = registry.runCommand("colorbonds #e5 red");
  assert.equal(oor.status, "nomatch");
  assert.equal(oor.message, `no edges match "#e5"`);
  // a range partly out of bounds keeps the in-range part (#e1-9 → edge 1)
  assert.equal(registry.runCommand("colorbonds #e1-9 red").message, "colored 1 edges red");
  assert.deepEqual(edgeOps[0].edgeIds, [1]);
  // a malformed #e token is a loud error, writes nothing
  const bad = registry.runCommand("colorbonds #eq red");
  assert.equal(bad.status, "error");
  assert.match(bad.message, /invalid #e edge-index/);
  // #e mixed with a point term is refused (edges and points don't union)
  assert.equal(registry.runCommand("colorbonds #e0+alpha red").status, "error");
});

test("colortrace: active subgroups → vertices, with the map-up to subgroup grain", () => {
  const { registry, traceOps, colorOps, edgeOps } = makeRegistry();
  // c0 = {0,1}: s0 active → vertex 0 (its anchor, point 0)
  const res = registry.runCommand("colortrace c0 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 1 trace vertices red");
  assert.deepEqual(traceOps[0], { vertexIds: [0], rgb: [1, 0, 0] });
  // THE MAP-UP: point 1 is NOT a vertex, but its subgroup s0 is activated,
  // so s0's vertex colors — resolution-to-granularity, not reach
  const up = registry.runCommand("colortrace c0.g0.s0.b steelblue");
  assert.equal(up.message, "colored 1 trace vertices steelblue");
  assert.deepEqual(traceOps[1].vertexIds, [0]);
  assert.equal(colorOps.length + edgeOps.length, 0, "no other primitive's buffer is touched");
});

test("colortrace: a target whose subgroups own no vertices is a nomatch", () => {
  const { registry, traceOps } = makeRegistry();
  // c1 = {2}: s1 is active but owns no polyline vertex
  const res = registry.runCommand("colortrace c1 red");
  assert.equal(res.status, "nomatch");
  assert.equal(res.message, `no trace vertices in "c1"`);
  assert.equal(traceOps.length, 0, "a no-vertex nomatch writes nothing");
});

test("colortrace: nomatch / bad color / usage / parse errors write NOTHING", () => {
  const { registry, traceOps } = makeRegistry();
  const nomatch = registry.runCommand("colortrace nothere red");
  assert.equal(nomatch.status, "nomatch");
  assert.match(nomatch.message, /nothing matches "nothere"/);
  const bad = registry.runCommand("colortrace c0 notacolor");
  assert.equal(bad.status, "error");
  assert.match(bad.message, /unknown color "notacolor"/);
  const bare = registry.runCommand("colortrace");
  assert.equal(bare.status, "error");
  assert.match(bare.message, /colortrace \[<target>\] <color>/);
  // ONE TOKEN THAT PARSES = the whole system: the target is optional for these
    // verbs now, so this is an OK that writes, not a usage error.
    const loneJunk = registry.runCommand("colortrace notacolor");
  assert.equal(loneJunk.status, "error");
  assert.match(loneJunk.message, /needs a color/);
  const parseErr = registry.runCommand("colortrace c0.[x] red"); // [ reserved
  assert.equal(parseErr.status, "error");
  assert.equal(traceOps.length, 0, "no path wrote anything");
});

// -- the size family: pointsize / bondsize / bondsizeof / tracesize -------------------

test("parseSize: non-negative numbers; negatives clamp; junk is null", () => {
  assert.deepEqual(parseSize("1.5"), { size: 1.5, clamped: false });
  assert.deepEqual(parseSize("0"), { size: 0, clamped: false });
  assert.deepEqual(parseSize("3"), { size: 3, clamped: false });
  assert.deepEqual(parseSize(".5"), { size: 0.5, clamped: false });
  assert.deepEqual(parseSize("2."), { size: 2, clamped: false });
  assert.deepEqual(parseSize("3e2"), { size: 300, clamped: false });
  assert.deepEqual(parseSize("-2"), { size: 0, clamped: true }, "negative clamps to 0");
  assert.deepEqual(parseSize("-0.1"), { size: 0, clamped: true });
  for (const junk of ["abc", "", "1,5", "1.5x", "--1", "Infinity", "NaN", "#3", "1 5"]) {
    assert.equal(parseSize(junk), null, junk);
  }
});

test("pointsize resolves EXACTLY like colorpoints/view; zero is literal, never a hide", () => {
  const { registry, sizeOps } = makeRegistry();
  const res = registry.runCommand("pointsize c0 2");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "set 2 points to size 2");
  assert.deepEqual(sizeOps[0], { kind: "points", ids: [0, 1], size: 2 });
  // ZERO: a legal literal value — the write happens, the message says size 0
  const zero = registry.runCommand("pointsize c0 0");
  assert.equal(zero.status, "ok");
  assert.equal(zero.message, "set 2 points to size 0", "reports the action, never 'hidden'");
  assert.deepEqual(sizeOps[1], { kind: "points", ids: [0, 1], size: 0 });
  // negative clamps, and the message says so
  const neg = registry.runCommand("pointsize c0 -2");
  assert.equal(neg.status, "ok");
  assert.equal(neg.message, "set 2 points to size 0 (clamped to 0)");
  assert.deepEqual(sizeOps[2].size, 0);
});

test("bondsize/bondsizeof use the IDENTICAL predicates as their color siblings", () => {
  const { registry, sizeOps, edgeOps } = makeRegistry();
  // both-endpoints: same edge set as colorbonds, on the size buffer
  registry.runCommand("colorbonds c0 red");
  registry.runCommand("bondsize c0 2");
  assert.deepEqual(sizeOps[0], { kind: "edges", ids: edgeOps[0].edgeIds, size: 2 });
  // either-endpoint: same edge set as colorbondsof (the incident reach)
  registry.runCommand("colorbondsof c0 red");
  registry.runCommand("bondsizeof c0 1.5");
  assert.deepEqual(sizeOps[1], { kind: "edges", ids: edgeOps[1].edgeIds, size: 1.5 });
  assert.deepEqual(sizeOps[1].ids, [0, 1], "edge 1 leans on an out-of-set endpoint — sized anyway");
  assert.equal(registry.runCommand("bondsize c0 2").message, "set 1 edges to size 2");
  assert.equal(registry.runCommand("bondsizeof c0 2").message, "set 2 edges to size 2");
});

test("single-point pin on the size axis: bondsize nomatches, bondsizeof sizes incidents", () => {
  const { registry, sizeOps } = makeRegistry();
  const bonds = registry.runCommand("bondsize c0.g0.s0.a 2");
  assert.equal(bonds.status, "nomatch");
  assert.equal(bonds.message, `no edges with both endpoints in "c0.g0.s0.a"`);
  assert.equal(sizeOps.length, 0);
  const bondsof = registry.runCommand("bondsizeof c0.g0.s0.a 2");
  assert.equal(bondsof.status, "ok");
  assert.equal(bondsof.message, "set 1 edges to size 2");
  assert.deepEqual(sizeOps[0].ids, [0]);
});

test("tracesize uses the IDENTICAL subgroup map-up as colortrace", () => {
  const { registry, sizeOps, traceOps } = makeRegistry();
  registry.runCommand("colortrace c0 red");
  registry.runCommand("tracesize c0 2.5");
  assert.deepEqual(sizeOps[0], { kind: "trace", ids: traceOps[0].vertexIds, size: 2.5 });
  // the map-up: point 1 is not a vertex; its subgroup's vertex sizes anyway
  const up = registry.runCommand("tracesize c0.g0.s0.b 1.5");
  assert.equal(up.message, "set 1 trace vertices to size 1.5");
  assert.deepEqual(sizeOps[1].ids, [0]);
  // no-vertex subgroups nomatch, identical wording to colortrace
  const none = registry.runCommand("tracesize c1 2");
  assert.equal(none.status, "nomatch");
  assert.equal(none.message, `no trace vertices in "c1"`);
});

test("the size verbs: nomatch / bad size / usage / parse errors write NOTHING", () => {
  const { registry, sizeOps } = makeRegistry();
  for (const verb of ["pointsize", "bondsize", "bondsizeof", "tracesize"]) {
    const nomatch = registry.runCommand(`${verb} nothere 2`);
    assert.equal(nomatch.status, "nomatch", verb);
    assert.match(nomatch.message, /nothing matches "nothere"/);
    const bad = registry.runCommand(`${verb} c0 abc`);
    assert.equal(bad.status, "error", verb);
    assert.match(bad.message, /not a size: "abc"/);
    const bare = registry.runCommand(verb);
    assert.equal(bare.status, "error", verb);
    assert.match(bare.message, new RegExp(`${verb} \\[<target>\\] <size>`));
    // ONE TOKEN THAT PARSES = the whole system: the target is optional for these
    // verbs now, so this is an OK that writes, not a usage error.
    const loneJunk = registry.runCommand(`${verb} notasize`);
    assert.equal(loneJunk.status, "error", verb);
    assert.match(loneJunk.message, /needs a size/);
    const parseErr = registry.runCommand(`${verb} c0.[x] 2`); // [ reserved
    assert.equal(parseErr.status, "error", verb);
  }
  assert.equal(sizeOps.length, 0, "no path wrote anything");
});

// -- the opacity family: pointopacity / bondopacity / bondopacityof / traceopacity ----

test("parseOpacity: [0,1] values; two-sided clamp; junk is null", () => {
  assert.deepEqual(parseOpacity("0.5"), { opacity: 0.5, clampedTo: null });
  assert.deepEqual(parseOpacity("0"), { opacity: 0, clampedTo: null });
  assert.deepEqual(parseOpacity("1"), { opacity: 1, clampedTo: null });
  assert.deepEqual(parseOpacity(".25"), { opacity: 0.25, clampedTo: null });
  assert.deepEqual(parseOpacity("-0.5"), { opacity: 0, clampedTo: 0 }, "below range clamps to 0");
  assert.deepEqual(parseOpacity("1.5"), { opacity: 1, clampedTo: 1 }, "above range clamps to 1");
  assert.deepEqual(parseOpacity("2e3"), { opacity: 1, clampedTo: 1 });
  for (const junk of ["abc", "", "0.5x", "--1", "Infinity", "NaN", "#5", "0 5"]) {
    assert.equal(parseOpacity(junk), null, junk);
  }
});

test("the THREE axes share one mapping per shape — set-identity across color/size/opacity", () => {
  const { registry, edgeOps, sizeOps, opacityOps, traceOps } = makeRegistry();
  // edge-contained: colorbonds / bondsize / bondopacity → the same edge ids
  registry.runCommand("colorbonds c0 red");
  registry.runCommand("bondsize c0 2");
  registry.runCommand("bondopacity c0 0.5");
  assert.deepEqual(opacityOps[0], { kind: "edges", ids: edgeOps[0].edgeIds, opacity: 0.5 });
  assert.deepEqual(opacityOps[0].ids, sizeOps[0].ids);
  // edge-incident: colorbondsof / bondsizeof / bondopacityof → the same ids
  registry.runCommand("colorbondsof c0 red");
  registry.runCommand("bondsizeof c0 2");
  registry.runCommand("bondopacityof c0 0.25");
  assert.deepEqual(opacityOps[1].ids, edgeOps[1].edgeIds);
  assert.deepEqual(opacityOps[1].ids, sizeOps[1].ids);
  assert.deepEqual(opacityOps[1].ids, [0, 1], "the incident reach, identical on every axis");
  // subgroup-vertex: colortrace / tracesize / traceopacity → the same vertex ids
  registry.runCommand("colortrace c0 red");
  registry.runCommand("tracesize c0 2");
  registry.runCommand("traceopacity c0 0.75");
  assert.deepEqual(opacityOps[2].ids, traceOps[0].vertexIds);
  assert.deepEqual(opacityOps[2].ids, sizeOps[2].ids);
});

test("pointopacity: zero is literal (never a hide); the clamp is two-sided and reported", () => {
  const { registry, opacityOps } = makeRegistry();
  const half = registry.runCommand("pointopacity c0 0.5");
  assert.equal(half.message, "set 2 points to opacity 0.5");
  assert.deepEqual(opacityOps[0], { kind: "points", ids: [0, 1], opacity: 0.5 });
  const zero = registry.runCommand("pointopacity c0 0");
  assert.equal(zero.status, "ok");
  assert.equal(zero.message, "set 2 points to opacity 0", "reports the action, never 'hidden'");
  assert.deepEqual(opacityOps[1].opacity, 0);
  const high = registry.runCommand("pointopacity c0 1.5");
  assert.equal(high.message, "set 2 points to opacity 1 (clamped to 1)");
  assert.equal(opacityOps[2].opacity, 1);
  const low = registry.runCommand("pointopacity c0 -0.5");
  assert.equal(low.message, "set 2 points to opacity 0 (clamped to 0)");
  assert.equal(opacityOps[3].opacity, 0);
});

test("single-point pin on the opacity axis: bondopacity nomatches, bondopacityof fades incidents", () => {
  const { registry, opacityOps } = makeRegistry();
  const bonds = registry.runCommand("bondopacity c0.g0.s0.a 0.5");
  assert.equal(bonds.status, "nomatch");
  assert.equal(bonds.message, `no edges with both endpoints in "c0.g0.s0.a"`);
  assert.equal(opacityOps.length, 0);
  const bondsof = registry.runCommand("bondopacityof c0.g0.s0.a 0.5");
  assert.equal(bondsof.status, "ok");
  assert.equal(bondsof.message, "set 1 edges to opacity 0.5");
  assert.deepEqual(opacityOps[0].ids, [0]);
});

test("traceopacity: the shared map-up, and the no-vertex nomatch", () => {
  const { registry, opacityOps } = makeRegistry();
  const up = registry.runCommand("traceopacity c0.g0.s0.b 0.5"); // maps up to s0's vertex
  assert.equal(up.message, "set 1 trace vertices to opacity 0.5");
  assert.deepEqual(opacityOps[0].ids, [0]);
  const none = registry.runCommand("traceopacity c1 0.5");
  assert.equal(none.status, "nomatch");
  assert.equal(none.message, `no trace vertices in "c1"`);
});

test("the opacity verbs: nomatch / bad value / usage / parse errors write NOTHING", () => {
  const { registry, opacityOps } = makeRegistry();
  for (const verb of ["pointopacity", "bondopacity", "bondopacityof", "traceopacity"]) {
    const nomatch = registry.runCommand(`${verb} nothere 0.5`);
    assert.equal(nomatch.status, "nomatch", verb);
    assert.match(nomatch.message, /nothing matches "nothere"/);
    const bad = registry.runCommand(`${verb} c0 abc`);
    assert.equal(bad.status, "error", verb);
    assert.match(bad.message, /not an opacity: "abc"/);
    const bare = registry.runCommand(verb);
    assert.equal(bare.status, "error", verb);
    assert.match(bare.message, new RegExp(`${verb} \\[<target>\\] <opacity>`));
    // ONE TOKEN THAT PARSES = the whole system: the target is optional for these
    // verbs now, so this is an OK that writes, not a usage error.
    const loneJunk = registry.runCommand(`${verb} notanopacity`);
    assert.equal(loneJunk.status, "error", verb);
    assert.match(loneJunk.message, /needs an? opacity/);
    const parseErr = registry.runCommand(`${verb} c0.[x] 0.5`); // [ reserved
    assert.equal(parseErr.status, "error", verb);
  }
  assert.equal(opacityOps.length, 0, "no path wrote anything");
});

test("colorpoints: nomatch / bad color / usage / parse errors write NOTHING", () => {
  const { registry, colorOps } = makeRegistry();
  const nomatch = registry.runCommand("colorpoints nothere red");
  assert.equal(nomatch.status, "nomatch");
  assert.match(nomatch.message, /nothing matches "nothere"/);
  const bad = registry.runCommand("colorpoints c0 notacolor");
  assert.equal(bad.status, "error");
  assert.match(bad.message, /unknown color "notacolor"/);
  const bare = registry.runCommand("colorpoints");
  assert.equal(bare.status, "error");
  assert.match(bare.message, /colorpoints \[<target>\] <color>/);
  // ONE TOKEN THAT PARSES = the whole system: the target is optional for these
    // verbs now, so this is an OK that writes, not a usage error.
    const loneJunk = registry.runCommand("colorpoints notacolor");
  assert.equal(loneJunk.status, "error");
  assert.match(loneJunk.message, /needs a color/);
  const parseErr = registry.runCommand("colorpoints c0.[x] red"); // [ reserved in expressions
  assert.equal(parseErr.status, "error");
  assert.equal(colorOps.length, 0, "no path wrote anything");
});

// `rainbow` — the one recipe verb — was REMOVED. Its per-element write
// discipline is `bake`'s below (the same applyColorScalars rail, same one
// stroke, same LWW); its hue sweep is the default PALETTE. What is tested here
// is the only thing the verb still owes a user: saying so.
test("RETIRED: `rainbow` is gone, fails closed, and names its successor", () => {
  const { registry, colorEachOps, colorOps } = makeRegistry();
  for (const text of ["rainbow", "rainbow c0", "rainbow @stored + all"]) {
    const r = registry.runCommand(text);
    assert.equal(r.status, "error", text);
    assert.match(r.message, /^rainbow was removed —/, text);
    // the successor must be TYPEABLE, not a shrug
    assert.match(r.message, /bake <target> <channel> color/, text);
    assert.match(r.message, /bind <target> <channel> color/, text);
    assert.match(r.message, /\?palette=rainbow/, text);
    assert.match(r.message, /colorpoints <target> <color>/, text);
  }
  assert.equal(colorEachOps.length + colorOps.length, 0, "and it writes nothing");
  // NOT a verb: absent from the pool, so it never completes and `help` has no
  // entry — the refusal is a dispatch-miss fallback, not a registration
  assert.ok(!registry.verbs().includes("rainbow"));
  assert.ok(!registry.isBuiltin("rainbow"));
  assert.equal(registry.describe("rainbow"), undefined);
  // `help rainbow` answers the same way — asking about a name that used to
  // work must not read as a typo
  const helped = registry.runCommand("help rainbow");
  assert.equal(helped.status, "nomatch");
  assert.match(helped.message, /^rainbow was removed —/);
  // a still-unknown verb keeps the plain message — retirement is not a catch-all
  assert.equal(registry.runCommand("bogusverb x").message, "unknown command: bogusverb");
  // the retired name is FREE: nothing reserves it against a workspace mod
  assert.ok(!HELP_TEXT.includes("rainbow <expr>"), "and it is out of the help text");
});

// -- bake: the Tier-1 channel consumer (channel → axis via the shared gate) -------

test("bake: a streamed channel with an explicit range writes each axis, one stroke", () => {
  const { registry, colorEachOps, eachOps } = makeRegistry();
  // energy declares min only — the explicit range is REQUIRED and given.
  // raw [0, 1.25, 2.5] over 0..2.5 → t = [0, 0.5, 1].
  const size = registry.runCommand("bake all energy size 0 2.5");
  assert.equal(size.status, "ok");
  assert.equal(size.message, 'baked "energy" → size on 3 points of "all" (frame 4, range 0..2.5)');
  assert.deepEqual(eachOps, [{ kind: "size", points: [0, 1, 2], values: [0, BIND_SIZE_MAX / 2, BIND_SIZE_MAX] }],
    "one writer stroke, t × BIND_SIZE_MAX");
  const opacity = registry.runCommand("bake all energy opacity 0 2.5");
  assert.equal(opacity.status, "ok");
  assert.deepEqual(eachOps[1], { kind: "opacity", points: [0, 1, 2], values: [0, 0.5, 1] }, "opacity is t as-is");
  const color = registry.runCommand("bake all energy color 0 2.5");
  assert.equal(color.status, "ok");
  // the DEFAULT palette's colormap: t=0 → red, t=1 → magenta (the hue sweep)
  assert.deepEqual(colorEachOps[0].rgb.slice(0, 3), [1, 0, 0]);
  assert.deepEqual(colorEachOps[0].rgb.slice(6, 9), [1, 0, 1]);
});

test("bake: a static per_point channel uses its DECLARED range and says static", () => {
  const { registry, eachOps } = makeRegistry();
  // mass [1,2,3] declared 1..3 → t = [0, 0.5, 1]
  const r = registry.runCommand("bake all mass size");
  assert.equal(r.status, "ok");
  assert.equal(r.message, 'baked "mass" → size on 3 points of "all" (static, range 1..3)');
  assert.deepEqual(eachOps[0].values, [0, BIND_SIZE_MAX / 2, BIND_SIZE_MAX]);
});

test("bake: out-of-range values saturate; the target selects and orders the write", () => {
  const { registry, eachOps } = makeRegistry();
  // range 0..1 over raw [0, 1.25, 2.5]: t clamps to [0, 1, 1]
  assert.equal(registry.runCommand("bake all energy opacity 0 1").status, "ok");
  assert.deepEqual(eachOps[0].values, [0, 1, 1]);
  // subgroup s1 = point 2 only → one element, its own value
  assert.equal(registry.runCommand("bake c1 energy opacity 0 2.5").status, "ok");
  assert.deepEqual(eachOps[1], { kind: "opacity", points: [2], values: [1] });
});

test("bake: the gate refuses loudly — nothing written on any failure", () => {
  const { registry, colorEachOps, eachOps } = makeRegistry();
  const cases: [string, RegExp][] = [
    ["bake all nope color", /no channel named "nope" — channels: energy, mass, time, flow/],
    ["bake all time color", /per-frame/],
    ["bake all flow color", /components: 3/],
    ["bake all energy color", /does not declare a full min\/max range/],
    ["bake all energy colr 0 1", /unknown axis "colr"/],
    ["bake all energy color 2 2", /min must be strictly less than max/],
    ["bake all energy color 1", /explicit range needs BOTH bounds/],
    ["bake all energy", /bake needs a target, a channel, and an axis/],
    ["bake", /bake needs a target, a channel, and an axis/],
  ];
  for (const [cmd, want] of cases) {
    const r = registry.runCommand(cmd);
    assert.equal(r.status, "error", cmd);
    assert.match(r.message, want, cmd);
  }
  // valid syntax, empty result: nomatch — the grammar's standing distinction
  assert.equal(registry.runCommand("bake zz energy color 0 1").status, "nomatch");
  assert.equal(colorEachOps.length + eachOps.length, 0, "no failure wrote anything");
});

test("bake: help surfaces the verb in both the summary and describe", () => {
  const { registry } = makeRegistry();
  assert.match(HELP_TEXT, /bake <expr> <channel> <axis>/);
  assert.match(registry.runCommand("help bake").message, /^bake — /);
});

// -- bind/unbind/bindings: the INERT binding registry (C-2) -----------------------

test("bind: registers through the SHARED gate, applies once, and says live", () => {
  const { registry, bindCalls, bindingReg } = makeRegistry();
  const r = registry.runCommand("bind all energy color 0 2.5");
  assert.equal(r.status, "ok");
  assert.equal(
    r.message,
    'bound "energy" → color on 3 points of "all" (applied at frame 4, range 0..2.5) — live: re-derives as the displayed frame changes',
  );
  // the composite got the binding AND the normalized scalars (the same
  // mapping bake proved: raw [0, 1.25, 2.5] over 0..2.5 → [0, 0.5, 1])
  assert.equal(bindCalls.length, 1);
  assert.deepEqual(bindCalls[0].b, {
    channel: "energy", axis: "color", points: [0, 1, 2], expr: "all", range: [0, 2.5],
  });
  assert.deepEqual(bindCalls[0].scalars, [0, 0.5, 1]);
  assert.equal(bindingReg.count(), 1);
});

test("bind: gate parity with bake — the same refusals, word for word", () => {
  const { registry, bindingReg } = makeRegistry();
  for (const [bakeCmd, bindCmd] of [
    ["bake all flow color", "bind all flow color"],
    ["bake all energy color", "bind all energy color"],
    ["bake all time color", "bind all time color"],
  ]) {
    const bake = registry.runCommand(bakeCmd);
    const bind = registry.runCommand(bindCmd);
    assert.equal(bind.status, "error", bindCmd);
    assert.equal(bind.message, bake.message, `${bakeCmd} vs ${bindCmd}`);
  }
  assert.equal(bindingReg.count(), 0, "no failure registered anything");
});

test("bind: last-bind-wins WITHIN an axis — the overlap is taken and reported; cross-axis coexists", () => {
  const { registry, bindingReg } = makeRegistry();
  registry.runCommand("bind all energy color 0 2.5");
  // a DIFFERENT axis over the same elements: coexists, takes nothing
  const size = registry.runCommand("bind all mass size");
  assert.equal(size.status, "ok");
  assert.doesNotMatch(size.message, /took/, "cross-axis bind reports no takeover");
  assert.equal(bindingReg.count(), 2);
  // the SAME axis over a subset: element-level takeover, reported
  const r = registry.runCommand("bind c1 mass color 1 3");
  assert.equal(r.status, "ok");
  assert.match(r.message, /took 1 elements from 1 earlier binding/);
  assert.deepEqual(bindingReg.all().map((b) => ({ channel: b.channel, axis: b.axis, points: b.points })), [
    { channel: "energy", axis: "color", points: [0, 1] },
    { channel: "mass", axis: "size", points: [0, 1, 2] },
    { channel: "mass", axis: "color", points: [2] },
  ]);
});

test("unbind: element-wise release; all clears; empty and no-overlap are nomatch", () => {
  const { registry, bindingReg } = makeRegistry();
  assert.equal(registry.runCommand("unbind all").status, "nomatch", "nothing bound yet");
  registry.runCommand("bind all energy color 0 2.5");
  const part = registry.runCommand("unbind c1"); // point 2 only
  assert.equal(part.status, "ok");
  assert.equal(part.message, "released 1 bound elements across 1 binding — values stay as last applied");
  assert.deepEqual(bindingReg.all().map((b) => b.points), [[0, 1]]);
  const rest = registry.runCommand("unbind all");
  assert.equal(rest.status, "ok");
  assert.equal(rest.message, "released 2 bound elements across 1 binding (1 removed) — values stay as last applied");
  assert.equal(bindingReg.count(), 0);
  assert.equal(registry.runCommand("unbind").status, "error", "bare unbind is a usage error");
});

test("unbind: an axis word scopes the release to that axis alone", () => {
  const { registry, bindingReg } = makeRegistry();
  registry.runCommand("bind all energy color 0 2.5");
  registry.runCommand("bind all mass size");
  const r = registry.runCommand("unbind all color");
  assert.equal(r.status, "ok");
  assert.equal(r.message, "released 3 bound elements across 1 binding (1 removed) on color — values stay as last applied");
  assert.deepEqual(bindingReg.all().map((b) => b.axis), ["size"], "the size binding is untouched");
  const part = registry.runCommand("unbind c1 size");
  assert.equal(part.message, "released 1 bound elements across 1 binding on size — values stay as last applied");
  assert.equal(registry.runCommand("unbind c1 color").status, "nomatch", "nothing bound on that axis there");
});

// -- orientation (O-1): the vector axis, STATE-ONLY — stored, listed, never drawn --

// The orientation tests run on a NON-IDENTITY vertex→point map ([0, 2]:
// vertex 1 → point 2), so the vertex-id and point-id spaces are numerically
// DISTINCT — with the default [0] fixture the two spaces coincide and a
// space-mixing regression is undetectable (found by adversarial review).
const ORI_FIXTURE = { traceVertices: [0, 2] };

test("orientation: bind accepts a 3-wide channel RAW onto polyline vertices, and says stored-only", () => {
  const { registry, bindingReg, bindCalls } = makeRegistry(ORI_FIXTURE);
  // vertex 0 → point 0's flow (1,0,0); vertex 1 → point 2's flow (0,0,1)
  const r = registry.runCommand("bind all flow orientation");
  assert.equal(r.status, "ok");
  assert.equal(
    r.message,
    'bound "flow" → orientation on 2 vertices of "all" (applied at frame 4, raw vectors) — live: re-derives as the displayed frame changes; drives the oriented shapes (shape traces ribbon)',
  );
  assert.equal(bindCalls.length, 1);
  assert.deepEqual(bindCalls[0].b.points, [0, 1],
    "coverage holds VERTEX ids — [0, 2] here would be the point ids leaking in");
  assert.deepEqual(bindCalls[0].scalars, [1, 0, 0, 0, 0, 1], "each vertex's OWN point's raw vector");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points, range: b.range })),
    [{ axis: "orientation", points: [0, 1], range: null }],
  );
  const list = registry.runCommand("bindings");
  assert.match(list.message, /flow → orientation on "all" — 2 vertices · raw vectors/);
});

test("orientation: bake stores once without a binding; wrong shapes refuse loudly", () => {
  const { registry, bindingReg, orientationOps } = makeRegistry(ORI_FIXTURE);
  const bake = registry.runCommand("bake all flow orientation");
  assert.equal(bake.status, "ok");
  assert.match(bake.message, /baked "flow" → orientation on 2 vertices of "all" \(frame 4, raw vectors\) — stored; drawn by the oriented shapes/);
  assert.equal(orientationOps.length, 1);
  assert.deepEqual(orientationOps[0], { vertexIds: [0, 1], values: [1, 0, 0, 0, 0, 1] },
    "vertex ids + each vertex's own point's raw vector");
  assert.equal(bindingReg.count(), 0, "bake registers nothing");
  const cases: [string, RegExp][] = [
    ["bind all energy orientation", /orientation needs a vector \(3-wide\) channel — "energy" is scalar/],
    ["bind all flow orientation 0 1", /meaningless for the orientation axis/],
    ["bake all energy orientation", /orientation needs a vector/],
  ];
  for (const [cmd, want] of cases) {
    const r = registry.runCommand(cmd);
    assert.equal(r.status, "error", cmd);
    assert.match(r.message, want, cmd);
  }
  assert.equal(orientationOps.length, 1, "no refusal wrote anything");
});

test("orientation: the two id spaces never mix — the DISCRIMINATING partial unbind", () => {
  const { registry, bindingReg } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all flow orientation"); // VERTEX ids: [0, 1]
  registry.runCommand("bind all energy color 0 2.5"); // POINT ids: [0, 1, 2]
  assert.equal(bindingReg.count(), 2, "cross-axis coexistence");
  // c1 = point 2. In vertex space that is vertex 1 (traceVertices[1] = 2).
  // CORRECT: orientation loses vertex 1, color loses point 2 → 2 elements
  // across 2 bindings, orientation coverage [0].
  // A space-mixing regression (releasing orientation with POINT ids {2})
  // would leave orientation [0, 1] untouched — this fixture DISCRIMINATES
  // (with the identity map [0] it could not; adversarial-review finding).
  const part = registry.runCommand("unbind c1");
  assert.equal(part.message, "released 2 bound elements across 2 bindings — values stay as last applied");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [{ axis: "orientation", points: [0] }, { axis: "color", points: [0, 1] }],
  );
  // …and the mirror: point 0 / vertex 0 collide numerically; unbind c0.g0.s0.a
  // (= point 0 = vertex 0's point) must shrink BOTH bindings by their OWN
  // element, never cross-shrink.
  const both = registry.runCommand("unbind c0.g0.s0.a");
  assert.equal(both.message, "released 2 bound elements across 2 bindings (1 removed) — values stay as last applied");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [{ axis: "color", points: [1] }],
  );
  // axis-scoped: unbind all orientation touches nothing (already gone)
  const none = registry.runCommand("unbind all orientation");
  assert.equal(none.status, "nomatch");
});

// -- offset: the second vector axis — vector-on-POINT, bind-only, unbind zeroes --
// Runs on ORI_FIXTURE (traceVertices [0, 2]) so the point-id and vertex-id
// spaces are numerically DISTINCT: the domain routing between the two vector
// axes is discriminated, not coincidental.

test("offset: bind accepts a 3-wide channel RAW onto POINT ids — no vertex map, no mean", () => {
  const { registry, bindingReg, bindCalls } = makeRegistry(ORI_FIXTURE);
  const r = registry.runCommand("bind all flow offset");
  assert.equal(r.status, "ok");
  assert.equal(
    r.message,
    'bound "flow" → offset on 3 points of "all" (applied at frame 4, raw vectors) — live: re-derives as the displayed frame changes; displaces the drawn positions (shown = raw + offset; unbind zeroes it)',
  );
  assert.equal(bindCalls.length, 1);
  assert.deepEqual(bindCalls[0].b.points, [0, 1, 2],
    "coverage holds POINT ids — [0, 1] here would be the vertex map leaking in");
  assert.deepEqual(bindCalls[0].scalars, [1, 0, 0, 0, 1, 0, 0, 0, 1],
    "each point's OWN raw vector, point order");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points, range: b.range })),
    [{ axis: "offset", points: [0, 1, 2], range: null }],
  );
  const list = registry.runCommand("bindings");
  assert.match(list.message, /flow → offset on "all" — 3 points · raw vectors/);
});

test("offset: the two vector axes route to DIFFERENT domains on the same scene", () => {
  const { registry, bindingReg } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all flow orientation"); // VERTEX ids [0, 1]
  registry.runCommand("bind all flow offset"); // POINT ids [0, 1, 2]
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [
      { axis: "orientation", points: [0, 1] },
      { axis: "offset", points: [0, 1, 2] },
    ],
    "same channel, same target — each vector axis covers its OWN id space",
  );
});

test("offset: the gate refusals name the offset axis; bake refuses it outright", () => {
  const { registry, bindingReg, orientationOps, offsetOps } = makeRegistry(ORI_FIXTURE);
  const cases: [string, RegExp][] = [
    ["bind all energy offset", /offset needs a vector \(3-wide\) channel — "energy" is scalar/],
    ["bind all flow offset 0 1", /meaningless for the offset axis/],
    ["bake all flow offset", /offset is bind-only/],
    ["bake all energy offset", /offset needs a vector/],
  ];
  for (const [cmd, want] of cases) {
    const r = registry.runCommand(cmd);
    assert.equal(r.status, "error", cmd);
    assert.match(r.message, want, cmd);
  }
  assert.equal(bindingReg.count(), 0, "no refusal bound anything");
  assert.equal(orientationOps.length + offsetOps.length, 0, "no refusal wrote anything");
});

test("offset: axis-scoped unbind ZEROES the released coverage — the departure from freeze", () => {
  const { registry, bindingReg, offsetOps } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all flow offset");
  offsetOps.length = 0; // drop the bind's initial apply — watch the release
  const r = registry.runCommand("unbind all offset");
  assert.equal(r.status, "ok");
  assert.equal(
    r.message,
    "released 3 bound elements across 1 binding (1 removed) on offset — offsets zeroed, positions return to raw",
  );
  assert.equal(bindingReg.count(), 0);
  assert.deepEqual(offsetOps, [{ points: [0, 1, 2], values: [0, 0, 0, 0, 0, 0, 0, 0, 0] }],
    "the released coverage was zero-written (recorded), not left frozen");
});

test("offset: a PARTIAL unbind zeroes only the released points; an all-axis unbind stays truthful per axis", () => {
  const { registry, bindingReg, offsetOps } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all flow offset");
  registry.runCommand("bind all energy color 0 2.5");
  offsetOps.length = 0;
  // c1 = point 2: offset loses point 2 (zeroed); color loses point 2 (frozen)
  const part = registry.runCommand("unbind c1");
  assert.equal(
    part.message,
    "released 2 bound elements across 2 bindings — values stay as last applied; 1 offset zeroed, positions return to raw",
  );
  assert.deepEqual(offsetOps, [{ points: [2], values: [0, 0, 0] }]);
  // an axis-scoped release of a NON-offset axis zeroes nothing
  offsetOps.length = 0;
  const color = registry.runCommand("unbind all color");
  assert.match(color.message, / on color — values stay as last applied$/);
  assert.equal(offsetOps.length, 0, "a color release never touches the offset buffer");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [{ axis: "offset", points: [0, 1] }],
  );
});

test("bindings: read-only list with the live notice; empty says so; bare only", () => {
  const { registry } = makeRegistry();
  assert.equal(registry.runCommand("bindings").message, "no bindings");
  registry.runCommand("bind all energy opacity 0 2.5");
  const r = registry.runCommand("bindings");
  assert.equal(r.status, "ok");
  const lines = r.message.split("\n");
  assert.match(lines[0], /1 binding \(live: re-derived from the channel as the displayed frame changes\):/);
  assert.equal(lines[1], '  energy → opacity on "all" — 3 points · range 0..2.5');
  assert.equal(registry.runCommand("bindings all").status, "error", "takes no arguments");
});

// -- palettes: WHICH ramp a bound/baked color axis maps through -------------------

test("palettes: the read-only registry listing (styles'/shapes' shape); bare only", () => {
  const { registry } = makeRegistry();
  const r = registry.runCommand("palettes");
  assert.equal(r.status, "ok");
  const lines = r.message.split("\n");
  assert.match(lines[0], /^palettes \(a bound color axis maps through one — bind … \?palette=<name>\):$/);
  assert.equal(lines.length, 1 + paletteNames().length, "one row per registered palette");
  assert.match(lines[1], /^ {2}rainbow \(default\) — /, "index 0 is marked the default");
  assert.match(lines[2], /^ {2}bluewhitered — diverging/);
  assert.match(lines[3], /^ {2}gray — sequential, perceptually uniform/);
  assert.equal(registry.runCommand("palettes all").status, "error", "takes no arguments");
  assert.match(registry.runCommand("help palettes").message, /^palettes — /);
});

test("DEFAULT BYTE-IDENTITY: no palette named → the sweep's exact colors, and NO palette stored", () => {
  const { registry, bindCalls, colorEachOps, bindingReg } = makeRegistry();
  // (a) the WRITE path — bake is the one that reaches the writers in this
  //     fixture (createBinding is a recording stub, as it has always been):
  //     t=[0,0.5,1] → red, hue 150, magenta, the exact values the hardcoded
  //     call produced
  assert.equal(registry.runCommand("bake all energy color 0 2.5").status, "ok");
  assert.deepEqual(colorEachOps[0].rgb, [1, 0, 0, 0, 1, 0.5, 1, 0, 1]);
  // (b) the BINDING path — message character-for-character as before
  const r = registry.runCommand("bind all energy color 0 2.5");
  assert.equal(r.status, "ok");
  assert.equal(
    r.message,
    'bound "energy" → color on 3 points of "all" (applied at frame 4, range 0..2.5) — live: re-derives as the displayed frame changes',
  );
  // (c) the Binding object has NO palette key at all (canonical form:
  //     undefined ⟺ the default), so snapshot/restore, the listing and
  //     save_rep all see exactly the object they saw before palettes existed
  assert.deepEqual(bindCalls[0].b, {
    channel: "energy", axis: "color", points: [0, 1, 2], expr: "all", range: [0, 2.5],
  });
  assert.ok(!("palette" in bindCalls[0].b), "no palette key on a default binding");
  assert.equal(bindingReg.all()[0].palette, undefined);
  // (d) and `bindings` says nothing about a palette
  const list = registry.runCommand("bindings").message;
  assert.equal(list.split("\n")[1], '  energy → color on "all" — 3 points · range 0..2.5');
  assert.doesNotMatch(list, /palette/);
});

test("bind ?palette=: the named ramp rides the Binding (what the per-flip applier reads)", () => {
  const { registry, bindCalls, bindingReg } = makeRegistry();
  const r = registry.runCommand("bind all energy color 0 2.5 ?palette=bluewhitered");
  assert.equal(r.status, "ok");
  assert.equal(
    r.message,
    'bound "energy" → color on 3 points of "all" (applied at frame 4, range 0..2.5, palette bluewhitered) — live: re-derives as the displayed frame changes',
  );
  // the palette is durable scene state: main.ts's createBinding forwards
  // b.palette to applyScalarsToAxis for the INITIAL write and the per-flip
  // applier resolves the same field, so first frame and every later frame
  // map through one ramp
  assert.equal(bindCalls[0].b.palette, "bluewhitered");
  assert.equal(bindingReg.all()[0].palette, "bluewhitered");
  // and that field, through the shared apply, is the diverging ramp:
  // t=[0,0.5,1] → blue, white, red — not the hue sweep
  const { ctx, colorEachOps } = makeRegistry();
  applyScalarsToAxis(ctx, "color", [0, 1, 2], [0, 0.5, 1], bindingReg.all()[0].palette);
  assert.deepEqual(colorEachOps[0].rgb, [0, 0, 1, 1, 1, 1, 1, 0, 0]);
});

test("bind ?palette=rainbow NORMALIZES to the default (one representation, not two)", () => {
  const { registry, bindCalls, colorEachOps } = makeRegistry();
  const r = registry.runCommand("bind all energy color 0 2.5 ?palette=rainbow");
  assert.equal(r.status, "ok");
  assert.ok(!("palette" in bindCalls[0].b), "an explicit default is stored as no palette");
  assert.doesNotMatch(r.message, /palette/, "and is not reported as a choice");
  assert.equal(registry.runCommand("bake all energy color 0 2.5 ?palette=rainbow").status, "ok");
  assert.deepEqual(colorEachOps[0].rgb, [1, 0, 0, 0, 1, 0.5, 1, 0, 1], "the sweep, unchanged");
});

test("bindings: shows the palette for a NON-default binding only", () => {
  const { registry } = makeRegistry();
  registry.runCommand("bind all energy color 0 2.5 ?palette=gray");
  registry.runCommand("bind all mass size");
  const list = registry.runCommand("bindings").message.split("\n");
  assert.equal(list[1], '  energy → color on "all" — 3 points · range 0..2.5 · palette gray');
  assert.equal(list[2], '  mass → size on "all" — 3 points · range 1..3', "a non-color axis has none");
});

test("bake ?palette=: the STATIC write takes the same option through the same parser", () => {
  // bake and bind share one argument parser by design, so the option cannot
  // work on one and not the other — and the static/animated look of the same
  // quantity can finally match, which is the whole complaint.
  const { registry, colorEachOps } = makeRegistry();
  const r = registry.runCommand("bake all energy color 0 2.5 ?palette=bluewhitered");
  assert.equal(r.status, "ok");
  assert.equal(r.message,
    'baked "energy" → color on 3 points of "all" (frame 4, range 0..2.5, palette bluewhitered)');
  assert.deepEqual(colorEachOps[0].rgb, [0, 0, 1, 1, 1, 1, 1, 0, 0]);
});

test("?palette= reaches EVERY color axis — all four, in their own id spaces", () => {
  // Through bake (the write path this fixture exercises) — bind rides the
  // same parser and the same apply, and stores the same name.
  const { registry, colorEachOps, elemEachOps, endsOps, bindingReg } = makeRegistry(ORI_FIXTURE);
  // point color: t=[0,0.5,1] → blue, white, red
  assert.equal(registry.runCommand("bake all energy color 0 2.5 ?palette=bluewhitered").status, "ok");
  assert.deepEqual(colorEachOps[0].rgb, [0, 0, 1, 1, 1, 1, 1, 0, 0]);
  // tracecolor: vertices [0,1] → points [0,2] → t=[0,1] → blue, red
  assert.equal(registry.runCommand("bake all energy tracecolor 0 2.5 ?palette=bluewhitered").status, "ok");
  assert.deepEqual(elemEachOps.at(-1), { axis: "tracecolor", ids: [0, 1], values: [0, 0, 1, 1, 0, 0] });
  // bondcolor: endpoint MEANS t=[0.25,0.75] → (0.5,0.5,1) and (1,0.5,0.5)
  assert.equal(registry.runCommand("bake all energy bondcolor 0 2.5 ?palette=bluewhitered").status, "ok");
  assert.deepEqual(elemEachOps.at(-1), { axis: "bondcolor", ids: [0, 1], values: [0.5, 0.5, 1, 1, 0.5, 0.5] });
  // bondcolorends: PER-ENDPOINT t — edge0 (0, 0.5), edge1 (0.5, 1)
  assert.equal(registry.runCommand("bake all energy bondcolorends 0 2.5 ?palette=bluewhitered").status, "ok");
  assert.deepEqual(endsOps.at(-1)!.a, [0, 0, 1, 1, 1, 1]);
  assert.deepEqual(endsOps.at(-1)!.b, [1, 1, 1, 1, 0, 0]);
  // and each one BINDS with the palette recorded — every color axis, not two
  for (const axis of COLOR_AXES) {
    assert.equal(registry.runCommand(`bind all energy ${axis} 0 2.5 ?palette=gray`).status, "ok", axis);
    assert.equal(bindingReg.all().at(-1)!.palette, "gray", axis);
  }
});

test("COLOR_AXES is EXACTLY the set of axes a palette CHANGES — derived, not copied", () => {
  // The completeness guarantee, mechanically and by OUTPUT (stronger than
  // "the colormap got called"): run every scalar axis through the shared
  // apply twice — default palette, then a different one — and collect the
  // axes whose written values differ. A new color axis that forgot to join
  // COLOR_AXES fails here; so would a listed axis that accepts a palette and
  // quietly ignores it; and the non-color axes are proven palette-INVARIANT.
  const changed: string[] = [];
  for (const axis of SCALAR_AXES) {
    const runs = ["rainbow", "bluewhitered"].map((palette) => {
      const f = makeRegistry(ORI_FIXTURE);
      // two scalars per element covers bondcolorends' interleaved pairs; the
      // other axes read only the first per element
      applyScalarsToAxis(f.ctx, axis, [0, 1], [0, 0.5, 1, 0.25], palette);
      return JSON.stringify([f.colorEachOps, f.elemEachOps, f.endsOps, f.eachOps]);
    });
    assert.notEqual(runs[0], "[[],[],[],[]]", `${axis} wrote nothing — the probe is vacuous`);
    if (runs[0] !== runs[1]) changed.push(axis);
  }
  assert.deepEqual(changed, [...COLOR_AXES],
    "the palette-sensitive axes and COLOR_AXES must be the same list");
});

test("?palette= FAILS CLOSED — unknown names, wrong axes, malformed options; nothing written", () => {
  const { registry, colorEachOps, elemEachOps, eachOps, endsOps, bindingReg } = makeRegistry();
  const cases: [string, RegExp][] = [
    // an unknown name NAMES the registered ones — never a silent default
    ["bind all energy color 0 2.5 ?palette=viridis",
      /^unknown palette "viridis" — palettes: rainbow, bluewhitered, gray$/],
    ["bake all energy color 0 2.5 ?palette=Gray",
      /^unknown palette "Gray" — palettes: rainbow, bluewhitered, gray$/],
    ["bind all energy color 0 2.5 ?palette=",
      /^unknown palette "" — palettes: rainbow, bluewhitered, gray$/],
    // a palette on an axis that does not map through one is refused, not ignored
    ["bind all energy size 0 2.5 ?palette=gray",
      /^a palette is meaningless on the size axis — \?palette= applies to the color axes only: color \| bondcolor \| bondcolorends \| tracecolor$/],
    ["bind all energy bonddash 0 2.5 ?palette=gray", /meaningless on the bonddash axis/],
    ["bind all flow orientation ?palette=gray", /meaningless on the orientation axis/],
    // malformed option blocks
    ["bind all energy color 0 2.5 ?", /^bind: empty option — the option is \?palette=<name>$/],
    ["bind all energy color 0 2.5 ?gray", /^bind: option "gray" must be key=value — \?palette=<name>$/],
    ["bind all energy color 0 2.5 ?ramp=gray",
      /^bind: unknown option "ramp" — the only option is \?palette=<name>$/],
    ["bind all energy color 0 2.5 ?palette=gray ?palette=rainbow",
      /^bind: option "palette" given twice$/],
    // OUT-OF-ORDER: the value swallows to the end of its segment, so the
    // refusal must blame the ORDER — never report a palette name the user
    // did not type ('unknown palette "gray 0 2.5"' was the adversarial find)
    ["bind all energy color ?palette=gray 0 2.5",
      /^bind: a palette name is one word and the \?palette= option must come LAST — "gray 0 2\.5" carries trailing text; write bind <target> <channel> <axis> \[<min> <max>\] \?palette=<name>$/],
    ["bind ?palette=gray all energy color 0 2.5", /must come LAST — "gray all energy color 0 2\.5" carries trailing text/],
    ["bake all energy color 0 2.5 ?palette=gray extra", /^bake: a palette name is one word and the \?palette= option must come LAST/],
    // UNKNOWN AXIS beats the palette refusal: the unknown-word error is the
    // one the user needs — asserting "meaningless on the bogusaxis axis"
    // would claim the word IS an axis and suppress the real message
    ["bind all energy bogusaxis 0 2.5 ?palette=gray", /^unknown axis "bogusaxis" — use /],
    // the sibling ? grammar's quote guard, inherited: an unclosed quote
    // would swallow the option into the target — rejected loudly instead
    ['bind all energy color 0 2.5 ?palette="gray', /^bind: unbalanced '"' in the invocation$/],
  ];
  for (const [cmd, want] of cases) {
    const r = registry.runCommand(cmd);
    assert.equal(r.status, "error", cmd);
    assert.match(r.message, want, cmd);
  }
  assert.equal(
    colorEachOps.length + elemEachOps.length + eachOps.length + endsOps.length + bindingReg.count(),
    0,
    "no refusal wrote anything or registered anything",
  );
});

test('?palette="quoted" unwraps by the grammar\'s ONE quoting convention', () => {
  // parseModParams' single-fully-quoted unwrap, inherited: quoting a value
  // must never CHANGE it. Before the guard was copied across,
  // ?palette="gray" reported 'unknown palette ""gray""' — the quoting
  // convention inverted for this one option.
  const { registry, bindCalls } = makeRegistry();
  const r = registry.runCommand('bind all energy color 0 2.5 ?palette="bluewhitered"');
  assert.equal(r.status, "ok", r.message);
  assert.equal(bindCalls[0].b.palette, "bluewhitered");
  // a quoted MULTI-WORD value is a deliberate quote — it reaches the
  // registry check and is refused under the name the user actually wrote
  const spaced = registry.runCommand('bind all energy color 0 2.5 ?palette="two words"');
  assert.equal(spaced.status, "error");
  assert.match(spaced.message, /^unknown palette "two words" — palettes: /);
});

test("?palette= cannot be misparsed as a positional argument (the reserved-? property)", () => {
  const { registry, bindCalls } = makeRegistry();
  // the option is invisible to the back-to-front word walk: the range still
  // parses, the axis is still the axis, the target still ends where it did
  assert.equal(registry.runCommand("bind all energy color ?palette=gray").status, "error",
    "energy declares min only — the range is still REQUIRED, the option did not supply one");
  assert.match(registry.runCommand("bind all energy color ?palette=gray").message,
    /does not declare a full min\/max range/);
  const ok = registry.runCommand("bind c0 energy color 0 2.5 ?palette=gray");
  assert.equal(ok.status, "ok");
  assert.deepEqual(bindCalls[0].b.points, [0, 1], "the target resolved as it always did");
  assert.deepEqual(bindCalls[0].b.range, [0, 2.5]);
  assert.equal(bindCalls[0].b.palette, "gray");
  // whitespace around the option is irrelevant; a bare `?` inside a TARGET is
  // a reserved character and still errors as one (parseTarget's own refusal)
  assert.equal(registry.runCommand("bind all energy color 0 2.5   ?palette=gray").status, "ok");
  assert.equal(registry.runCommand("bind a?b energy color 0 2.5").status, "error");
});

test("?palette= tab-completes: the option NAME then the registry's names", () => {
  const { registry, ctx } = makeRegistry();
  const at = (text: string) => completeCommand(ctx, registry, text, text.length);
  // the option name, with `=` appended on a unique match
  const name = at("bind all energy color 0 2.5 ?pal");
  assert.deepEqual(name.candidates, ["palette"]);
  assert.equal(name.applied, "ette=", "the extension from the cursor, plus the separator");
  assert.equal(name.kind, "param");
  assert.equal(name.start, "bind all energy color 0 2.5 ?".length);
  // an EMPTY value completes the whole registry (completeToken sorts every
  // slot's candidates — the listing verb is where registration order shows)
  const empty = at("bind all energy color 0 2.5 ?palette=");
  assert.deepEqual(empty.candidates, [...paletteNames()].sort());
  assert.equal(empty.kind, "value");
  assert.equal(empty.start, "bind all energy color 0 2.5 ?palette=".length);
  // a prefix filters and settles
  const one = at("bind all energy color 0 2.5 ?palette=bl");
  assert.deepEqual(one.candidates, ["bluewhitered"]);
  assert.equal(one.applied, "uewhitered");
  // bake completes it identically (one parser, one completer)
  assert.deepEqual(at("bake all energy color 0 2.5 ?palette=g").candidates, ["gray"]);
  // an unknown option key enumerates nothing — never a guess
  assert.deepEqual(at("bind all energy color 0 2.5 ?ramp=g").candidates, []);
  // and the POSITIONAL slots are untouched: no unquoted `?` → old behavior
  assert.deepEqual(at("bind all ener").candidates, ["energy"]);
  assert.equal(at("bind all energy col").kind, "axis");
});

// -- A-1: per-element edge/trace axes (bond*/trace* — the completeness pass) -----

test("A-1 bake: edge axes use the ENDPOINT MEAN, contained edges only", () => {
  const { registry, elemEachOps } = makeRegistry();
  // edges [[0,1],[1,2]]; energy raw [0, 1.25, 2.5], range 0..2.5:
  // edge0 mean 0.625 → t 0.25 → size 1.5; edge1 mean 1.875 → t 0.75 → 4.5
  const r = registry.runCommand("bake all energy bondsize 0 2.5");
  assert.equal(r.status, "ok");
  assert.equal(r.message, 'baked "energy" → bondsize on 2 edges of "all" (frame 4, range 0..2.5, endpoint mean)');
  assert.deepEqual(elemEachOps, [{ axis: "bondsize", ids: [0, 1], values: [1.5, 4.5] }]);
  // contained rule: a target holding only ONE endpoint matches no edge
  const none = registry.runCommand("bake c1 energy bondsize 0 2.5");
  assert.equal(none.status, "nomatch");
  assert.match(none.message, /no edges contained in "c1"/);
});

test("bonddash bake/bind: endpoint MEAN through the size-style fixed range, edge id space", () => {
  const { registry, elemEachOps, bindingReg } = makeRegistry();
  // energy raw [0, 1.25, 2.5] over 0..2.5: edge0 mean t=0.25 → dash 1;
  // edge1 mean t=0.75 → dash 3 (t × BIND_DASH_MAX — bondsize's pattern)
  const r = registry.runCommand("bake all energy bonddash 0 2.5");
  assert.equal(r.status, "ok");
  assert.equal(r.message, 'baked "energy" → bonddash on 2 edges of "all" (frame 4, range 0..2.5, endpoint mean)');
  assert.deepEqual(elemEachOps, [{ axis: "bonddash", ids: [0, 1], values: [1, 3] }]);
  const b = registry.runCommand("bind all energy bonddash 0 2.5");
  assert.equal(b.status, "ok");
  assert.match(b.message, /bound "energy" → bonddash on 2 edges of "all" .*endpoint mean.*live/);
  assert.deepEqual(
    bindingReg.all().map((x) => ({ axis: x.axis, points: x.points })),
    [{ axis: "bonddash", points: [0, 1] }],
  );
  const list = registry.runCommand("bindings").message;
  assert.match(list, /energy → bonddash on "all" — 2 edges · range 0\.\.2\.5 · endpoint mean/);
});

test("bondcolorends bake: PER-ENDPOINT scalars (no mean) reach the ends writer", () => {
  const { registry, endsOps, elemEachOps } = makeRegistry();
  // mass raw [1,2,3], declared 1..3 → per-point t [0, 0.5, 1]. Edges
  // [[0,1],[1,2]]: edge0 halves t (0, 0.5); edge1 halves t (0.5, 1) —
  // NEVER a mean. Colormapped: t0 → red [1,0,0]; t1 → magenta [1,0,1];
  // both t=0.5 halves must agree with each other.
  const r = registry.runCommand("bake all mass bondcolorends");
  assert.equal(r.status, "ok");
  assert.equal(r.message,
    'baked "mass" → bondcolorends on 2 edges of "all" (static, range 1..3, per endpoint)');
  assert.equal(endsOps.length, 1);
  assert.deepEqual(endsOps[0].ids, [0, 1]);
  assert.deepEqual(endsOps[0].a.slice(0, 3), [1, 0, 0], "edge0's A half is t=0 red");
  assert.deepEqual(endsOps[0].b.slice(3, 6), [1, 0, 1], "edge1's B half is t=1 magenta");
  assert.deepEqual(endsOps[0].b.slice(0, 3), endsOps[0].a.slice(3, 6),
    "edge0's B half == edge1's A half (both t=0.5 — the same colormap)");
  assert.equal(elemEachOps.length, 0, "the mean-rule writers are never touched");
  // contained rule is colorbonds' — one-endpoint targets nomatch
  const none = registry.runCommand("bake c1 mass bondcolorends");
  assert.equal(none.status, "nomatch");
  assert.match(none.message, /no edges contained in "c1"/);
});

test("bondcolorends bind: registers in the EDGE id space, lists per endpoint, gate-shared", () => {
  const { registry, bindingReg, bindCalls } = makeRegistry();
  const r = registry.runCommand("bind all mass bondcolorends");
  assert.equal(r.status, "ok");
  assert.match(r.message, /bound "mass" → bondcolorends on 2 edges of "all" .*per endpoint.*live/);
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [{ axis: "bondcolorends", points: [0, 1] }],
  );
  // the composite received the INTERLEAVED per-endpoint scalars [A0,B0,A1,B1]
  assert.deepEqual(bindCalls[0].scalars, [0, 0.5, 0.5, 1]);
  const list = registry.runCommand("bindings").message;
  assert.match(list, /mass → bondcolorends on "all" — 2 edges · range 1\.\.3 · per endpoint/);
  // and the gate is THE shared one: vector channels refuse by width
  const bad = registry.runCommand("bake all flow bondcolorends");
  assert.equal(bad.status, "error");
  assert.match(bad.message, /components: 3/);
});

test("A-1 bake: trace axes read each vertex's OWN point (the orientation map)", () => {
  const { registry, elemEachOps } = makeRegistry(ORI_FIXTURE);
  // vertices [0,1] → points [0,2] → raw [0, 2.5] → t [0,1] → sizes [0,6]
  const r = registry.runCommand("bake all energy tracesize 0 2.5");
  assert.equal(r.status, "ok");
  assert.equal(r.message, 'baked "energy" → tracesize on 2 vertices of "all" (frame 4, range 0..2.5)');
  assert.deepEqual(elemEachOps, [{ axis: "tracesize", ids: [0, 1], values: [0, 6] }]);
});

test("A-1 bind: edge/trace bindings register in their own id spaces and list with their nouns", () => {
  const { registry, bindingReg } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all energy bondsize 0 2.5");
  registry.runCommand("bind all energy tracecolor 0 2.5");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [{ axis: "bondsize", points: [0, 1] }, { axis: "tracecolor", points: [0, 1] }],
  );
  const list = registry.runCommand("bindings").message;
  assert.match(list, /energy → bondsize on "all" — 2 edges · range 0\.\.2\.5 · endpoint mean/);
  assert.match(list, /energy → tracecolor on "all" — 2 vertices · range 0\.\.2\.5/);
});

test("A-1: the THREE id spaces never mix — the edge-space discriminator", () => {
  const { registry, bindingReg } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all energy size 0 2.5"); // points [0,1,2]
  registry.runCommand("bind all energy bondsize 0 2.5"); // edges [0,1]
  registry.runCommand("bind all energy tracesize 0 2.5"); // vertices [0,1]
  assert.equal(bindingReg.count(), 3);
  // c0 = points {0,1}: contained edges = {0} ONLY (edge 1 needs point 2).
  // A space-mixing regression releasing edge coverage with POINT ids {0,1}
  // would drop BOTH edges — this discriminates: edge 1 must survive.
  const r = registry.runCommand("unbind c0");
  assert.equal(r.message, "released 4 bound elements across 3 bindings — values stay as last applied");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [
      { axis: "size", points: [2] },
      { axis: "bondsize", points: [1] },
      { axis: "tracesize", points: [1] },
    ],
  );
});

// -- A-2: per-target style selection ---------------------------------------------

test("A-2: style verbs write the REGISTRY INDEX per family targeting; unknown names list the registry", () => {
  const { registry, styleOps } = makeRegistry();
  const p = registry.runCommand("stylepoints all matte");
  assert.equal(p.status, "ok");
  assert.equal(p.message, "styled 3 points matte");
  assert.deepEqual(styleOps[0], { kind: "points", ids: [0, 1, 2], index: 1 });
  const b = registry.runCommand("stylebonds all standard");
  assert.equal(b.message, "styled 2 edges standard");
  assert.deepEqual(styleOps[1], { kind: "edges", ids: [0, 1], index: 0 });
  // contained rule: c1 = point 2 only → no contained edge
  assert.equal(registry.runCommand("stylebonds c1 matte").status, "nomatch");
  const t = registry.runCommand("styletrace c0 matte");
  assert.equal(t.message, "styled 1 polyline vertices matte");
  assert.deepEqual(styleOps[2], { kind: "trace", ids: [0], index: 1 });
  const bad = registry.runCommand("stylepoints all glossy");
  assert.equal(bad.status, "error");
  assert.match(bad.message, /unknown style "glossy" — styles: standard, matte/);
  assert.equal(styleOps.length, 3, "no failure wrote anything");
  const list = registry.runCommand("styles");
  assert.equal(list.message, "styles:\n  standard (default)\n  matte");
});

// -- A-3: per-domain shape selection ----------------------------------------------

test("A-3: shape swaps a domain's active shape; wrong names list the registry; shapes lists all", () => {
  const { registry, shapeOps, shapeActive } = makeRegistry();
  const r = registry.runCommand("shape traces ribbon");
  assert.equal(r.status, "ok");
  // no orientation binding exists → the vanish-warning rides the message
  assert.equal(
    r.message,
    "traces now draw as ribbon (was tube) — NOTE: ribbon reads the orientation axis and nothing is bound to it, so nothing will draw (bind a vector channel: bind <target> <channel> orientation)",
  );
  assert.deepEqual(shapeOps, [{ domain: "vertex", label: "ribbon" }]);
  assert.equal(shapeActive.vertex, "ribbon");
  const noop = registry.runCommand("shape traces ribbon");
  assert.match(noop.message, /^traces already draw as ribbon — NOTE:/);
  const badShape = registry.runCommand("shape points cube");
  assert.equal(badShape.status, "error");
  assert.match(badShape.message, /no shape "cube" for points — registered: sphere/);
  const badDomain = registry.runCommand("shape lines tube");
  assert.match(badDomain.message, /unknown domain "lines" — use points \| bonds \| traces/);
  const bare = registry.runCommand("shape traces");
  assert.equal(bare.status, "error");
  const list = registry.runCommand("shapes");
  assert.equal(list.message, "shapes:\n  points: sphere (active)\n  bonds: tube (active)\n  traces: tube  ribbon (active)");
});

test("A-3+: the vanish-warning clears once the required axis is bound", () => {
  const { registry } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all flow orientation");
  const r = registry.runCommand("shape traces ribbon");
  assert.equal(r.status, "ok");
  assert.equal(r.message, "traces now draw as ribbon (was tube)", "no warning when the axis is bound");
});

// -- background: the targetless scene-background primitive -------------------------

test("background: one color token sets the scene background through the context", () => {
  const { registry, bgOps } = makeRegistry();
  const named = registry.runCommand("background navy");
  assert.equal(named.status, "ok");
  assert.equal(named.message, "background → navy");
  const hex = registry.runCommand("background #ff8800");
  assert.equal(hex.status, "ok");
  assert.equal(hex.message, "background → #ff8800");
  // ONE parser (parseColor) — the writes carry its exact 0..1 fractions
  assert.deepEqual(bgOps, [[0, 0, 0x80 / 255], [1, 0x88 / 255, 0]]);
});

test("background: quiet errors — bare, extra tokens, non-color; none writes", () => {
  const { registry, bgOps } = makeRegistry();
  const bare = registry.runCommand("background");
  assert.equal(bare.status, "error");
  assert.match(bare.message, /background needs exactly one color — background <color> \(e\.g\. background navy\)/);
  const extra = registry.runCommand("background navy extra");
  assert.equal(extra.status, "error");
  assert.match(extra.message, /needs exactly one color/);
  const bad = registry.runCommand("background notacolor");
  assert.equal(bad.status, "error");
  // the EXACT resolveColorArgs wording — the family's one bad-color message
  assert.equal(bad.message, 'unknown color "notacolor" — use a CSS color name (red, steelblue) or hex (#ff8800)');
  assert.equal(bgOps.length, 0, "no failure wrote anything");
});

test("background: surfaced by help — the summary line and the verb description", () => {
  const { registry } = makeRegistry();
  assert.match(HELP_TEXT, /background <color>/);
  assert.match(registry.runCommand("help background").message, /^background — /);
});

test("bind family: help surfaces all three verbs", () => {
  const { registry } = makeRegistry();
  assert.match(HELP_TEXT, /bind <expr> <channel> <axis>/);
  assert.match(HELP_TEXT, /unbind <expr>\|all/);
  for (const verb of ["bind", "unbind", "bindings"]) {
    assert.match(registry.runCommand(`help ${verb}`).message, new RegExp(`^${verb} — `));
  }
});

test("mods: an EMPTY registry says so — there is no built-in mod any more", () => {
  // `rainbow` used to occupy this listing's built-in group. With it retired the
  // registry ships empty, and the read face must say that rather than print a
  // bare origin header.
  const { registry } = makeRegistry();
  const r = registry.runCommand("mods");
  assert.equal(r.status, "ok");
  assert.equal(r.message, "no recipes");
});

test("mods: lists the registry — grouped under its origin header, with credit", () => {
  registerRecipe({
    name: "zz_listed",
    kind: "representation",
    axis: "point-color",
    compute: (points) => points.map(() => 0.5),
    colormap: () => [0, 0, 0],
    origin: "built-in",
    author: "A Person",
    source: "https://example.invalid/x",
  });
  try {
    const { registry } = makeRegistry();
    const r = registry.runCommand("mods");
    assert.equal(r.status, "ok");
    const lines = r.message.split("\n");
    assert.ok(lines.includes("built-in:"), "grouped by origin");
    assert.ok(
      lines.includes("  zz_listed — representation · point-color · by A Person · https://example.invalid/x"),
      r.message);
    assert.ok(lines.indexOf("built-in:") < lines.findIndex((l) => l.startsWith("  zz_listed")),
      "recipe rows sit under their origin header");
    assert.ok(!r.message.includes("colorpoints") && !r.message.includes("view"),
      "recipes only — verb discoverability stays with help/?");
  } finally {
    unregisterRecipe("zz_listed");
  }
});

test("mods: attribution renders for ANY recipe's credit; author/source stay optional", () => {
  // a stub with distinct provenance strings proves the credit display isn't
  // specific to any one mod; a bare stub pins that credit fields are optional
  registerRecipe({
    name: "stub-credit",
    kind: "representation",
    axis: "point-color",
    compute: (points) => points.map(() => 0),
    colormap: () => [0, 0, 0],
    origin: "built-in",
    author: "Stub Author",
    source: "stub-source-string",
  });
  registerRecipe({
    name: "stub-plain",
    kind: "representation",
    axis: "point-color",
    compute: (points) => points.map(() => 0),
    colormap: () => [0, 0, 0],
    origin: "built-in",
  });
  const { registry } = makeRegistry();
  const lines = registry.runCommand("mods").message.split("\n");
  assert.ok(lines.includes("  stub-credit — representation · point-color · by Stub Author · stub-source-string"),
    lines.join("|"));
  assert.ok(lines.includes("  stub-plain — representation · point-color"), "no credit fields → the bare line");
});

test("mods: stray arguments are a usage error, nothing listed", () => {
  const { registry } = makeRegistry();
  const r = registry.runCommand("mods zz_anything");
  assert.equal(r.status, "error");
  assert.equal(r.message, "mods takes no arguments — it lists the recipe registry");
  assert.ok(!r.message.includes("built-in:"), "no listing rides the error");
  assert.ok(registry.verbs().includes("mods"), "registered like every verb");
});


// -- the typed-result binding (claudebind.ts) — dispatch on the stub ctx ----------

function makeBinder() {
  const made = makeRegistry();
  const run = (raw: unknown) =>
    bindTypedResult(made.ctx, (t) => made.registry.runCommand(t), raw);
  return { ...made, run };
}

test("bind per-point-scalar color: header-ordered points through the built-in colormap", () => {
  const { run, colorEachOps } = makeBinder();
  // c0 = {0,1}: scalars 0 and 1 → the hue sweep's ends (red, magenta)
  const out = run({ kind: "per-point-scalar", target: "c0", axis: "color", scalars: [0, 1] });
  assert.equal(out.ok, true, out.message);
  assert.match(out.message, /colored 2 points of "c0" from scalars/);
  assert.equal(colorEachOps.length, 1, "one per-element write = one stroke");
  assert.deepEqual(colorEachOps[0].points, [0, 1], "view's exact resolution order");
  assert.deepEqual(colorEachOps[0].rgb, [1, 0, 0, 1, 0, 1], "scalar 0 → red, 1 → magenta");
});

test("bind per-point-scalar size/opacity: [0,1] maps to the axis range, per element", () => {
  const { run, eachOps } = makeBinder();
  const sized = run({ kind: "per-point-scalar", target: "all", axis: "size", scalars: [0, 0.5, 1] });
  assert.equal(sized.ok, true, sized.message);
  assert.deepEqual(eachOps[0],
    { kind: "size", points: [0, 1, 2], values: [0, BIND_SIZE_MAX / 2, BIND_SIZE_MAX] },
    "size: t*6 — a fixed visual range, never an interpretation");
  const faded = run({ kind: "per-point-scalar", target: "all", axis: "opacity", scalars: [0, 0.5, 1] });
  assert.equal(faded.ok, true, faded.message);
  assert.deepEqual(eachOps[1],
    { kind: "opacity", points: [0, 1, 2], values: [0, 0.5, 1] },
    "opacity: identity — [0,1] IS its range");
});

test("bind command: runs the exact command path and changes scene state", () => {
  const { run, commits } = makeBinder();
  const out = run({ kind: "command", command: "create_sele c0 [assistant_pick]" });
  assert.equal(out.ok, true, out.message);
  assert.match(out.message, /^create_sele c0 \[assistant_pick\] → created "assistant_pick"/);
  assert.equal(commits.length, 1, "the command really committed a selection");
  const bad = run({ kind: "command", command: "view nothere" });
  assert.equal(bad.ok, false, "a nomatch command is a failed binding");
  assert.match(bad.message, /nothing matches/);
});

test("bind per-frame-series: DEFENSIVE only — the host routes series to the plot panel", () => {
  // production never sends a series here (the host intercepts it before the
  // viewer relay; main.ts also guards); the branch stays as a closed-union
  // safety net that writes nothing
  const { run, colorEachOps, eachOps, commits } = makeBinder();
  const out = run({ kind: "per-frame-series", label: "example_series", values: [0, 0.5, 1] });
  assert.equal(out.ok, false);
  assert.match(out.message, /per-frame-series is routed to the plot panel/);
  assert.equal(colorEachOps.length + eachOps.length + commits.length, 0, "wrote nothing");
});

test("bind: length mismatch writes NOTHING and errors (no partial writes)", () => {
  const { run, colorEachOps, eachOps } = makeBinder();
  const out = run({ kind: "per-point-scalar", target: "c0", axis: "color", scalars: [0.5] });
  assert.equal(out.ok, false);
  assert.match(out.message, /scalar count mismatch: 1 values for 2 points of "c0" — nothing written/);
  const nomatch = run({ kind: "per-point-scalar", target: "nothere", axis: "size", scalars: [1] });
  assert.equal(nomatch.ok, false);
  assert.match(nomatch.message, /nothing matches "nothere"/);
  assert.equal(colorEachOps.length + eachOps.length, 0, "no path wrote anything");
});

test("bind: the union is CLOSED — unknown kinds and junk error, never guess", () => {
  const { run, colorEachOps, eachOps, commits } = makeBinder();
  for (const raw of [
    { kind: "per-point-vector", target: "c0", scalars: [1] },
    { kind: "command" },                                   // missing field
    { kind: "per-point-scalar", target: "c0", axis: "hue", scalars: [1] }, // bad axis
    { kind: "per-point-scalar", target: "c0", axis: "color", scalars: ["x"] }, // bad values
    null, 42, "command", {},
  ]) {
    const out = run(raw);
    assert.equal(out.ok, false, JSON.stringify(raw));
    assert.match(out.message, /unrecognized result payload/, JSON.stringify(raw));
  }
  assert.equal(colorEachOps.length + eachOps.length + commits.length, 0, "wrote nothing");
});

// -- Type A (analysis) mod verbs: resolve → hand off, routing by produces --------

test("an analysis mod verb resolves like every verb and hands off the EXACT indices", () => {
  const { registry, ctx, modRuns } = makeRegistry();
  const mod = {
    name: "index_ramp", kind: "analysis" as const, produces: "per-point-scalar" as const,
    axis: "color" as const, code: "def compute(data, target_indices):\n    return []",
    origin: "workspace" as const,
  };
  registry.register("index_ramp", makeAnalysisModHandler(ctx, mod), "test mod");
  const res = registry.runCommand("index_ramp c0");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "running index_ramp on 2 points…", "the sync acknowledgement");
  assert.deepEqual(modRuns, [{ name: "index_ramp", points: [0, 1], expr: "c0" }],
    "view's exact header-ordered resolution, handed off verbatim");
  // nomatch / bare / parse errors NEVER reach the producer
  assert.equal(registry.runCommand("index_ramp nothere").status, "nomatch");
  assert.equal(registry.runCommand("index_ramp").status, "error");
  assert.equal(registry.runCommand("index_ramp c0.[x]").status, "error");
  assert.equal(modRuns.length, 1, "only the valid invocation ran");
});

// -- P-1: parameters — the ?-delimited invocation split + validation --------------

const PARAMIZED: AnalysisMod = {
  name: "gated", kind: "analysis", produces: "commands", origin: "workspace",
  params: [
    { name: "floor", type: "number", default: 0.5 },
    { name: "label", type: "string" }, // required
  ],
  code: "def compute(data, target_indices, params):\n    return []",
};

test("parseModParams: splits target from ?params, coerces, fills defaults", () => {
  const r = parseModParams(PARAMIZED, 'alpha.A ?floor=0.8 ?label=some words');
  assert.deepEqual(r, { expr: "alpha.A", params: { floor: 0.8, label: "some words" } },
    "target keeps its shape; a value may hold spaces (delimited by the next ?)");
  // a default fills when the parameter is omitted
  assert.deepEqual(parseModParams(PARAMIZED, "alpha ?label=x"),
    { expr: "alpha", params: { floor: 0.5, label: "x" } });
  // a `?` inside a quoted VALUE is not a boundary
  assert.deepEqual(parseModParams(PARAMIZED, 'alpha ?label="a?b"'),
    { expr: "alpha", params: { floor: 0.5, label: "a?b" } });
  // a `?` inside a quoted TARGET label stays in the target
  const q = parseModParams(PARAMIZED, '"a?b" ?label=x');
  assert.ok(!("status" in q) && q.expr === '"a?b"', "the quoted label with ? stays the target");
});

test("parseModParams: fail-closed by name — unknown, missing required, wrong type, malformed", () => {
  assert.match((parseModParams(PARAMIZED, "alpha ?label=x ?nope=1") as CommandResult).message, /unknown parameter "nope"/);
  assert.match((parseModParams(PARAMIZED, "alpha ?floor=0.8") as CommandResult).message, /missing required parameter "label"/);
  assert.match((parseModParams(PARAMIZED, "alpha ?floor=big ?label=x") as CommandResult).message, /parameter "floor" expects a number/);
  assert.match((parseModParams(PARAMIZED, "alpha ?floor") as CommandResult).message, /must be key=value/);
  assert.match((parseModParams(PARAMIZED, "alpha ?label=x ?label=y") as CommandResult).message, /"label" given twice/);
  // a paramless mod: passing a parameter is "unknown", none is fine
  const noneMod: AnalysisMod = { ...PARAMIZED, params: undefined };
  assert.match((parseModParams(noneMod, "alpha ?x=1") as CommandResult).message, /this mod declares no parameters/);
  assert.deepEqual(parseModParams(noneMod, "alpha"), { expr: "alpha" }, "no params → no params key");
});

test("parseModParams: unbalanced/interior quotes fail LOUD, never a silent swallow", () => {
  // an unbalanced quote in a value would otherwise swallow the next ?param — reject it
  assert.match((parseModParams(PARAMIZED, 'alpha ?label=x" ?floor=0.8') as CommandResult).message, /unbalanced '"'/);
  // a value that starts+ends with " but has an interior quote is NOT unwrapped to
  // mangled text; the interior " then trips the double-quote refusal
  assert.match((parseModParams(PARAMIZED, 'alpha ?label="a" "b"') as CommandResult).message, /cannot contain a double-quote/);
  // the legitimate single-quoted-region case still unwraps
  assert.deepEqual(parseModParams(PARAMIZED, 'alpha ?label="a?b"'), { expr: "alpha", params: { floor: 0.5, label: "a?b" } });
});

test("an analysis mod hands the resolved parameters to the producer round-trip", () => {
  const { registry, ctx, modRuns } = makeRegistry();
  const mod: AnalysisMod = {
    name: "gated", kind: "analysis", produces: "per-point-scalar", axis: "color",
    origin: "workspace", params: [{ name: "floor", type: "number", default: 0.5 }],
    code: "def compute(data, target_indices, params):\n    return []",
  };
  registry.register("gated", makeAnalysisModHandler(ctx, mod), "test mod");
  assert.equal(registry.runCommand("gated c0 ?floor=0.9").status, "ok");
  assert.deepEqual(modRuns, [{ name: "gated", points: [0, 1], expr: "c0", params: { floor: 0.9 } }]);
  // a bad parameter never reaches the producer
  assert.equal(registry.runCommand("gated c0 ?floor=nope").status, "error");
  assert.equal(registry.runCommand("gated c0 ?bogus=1").status, "error");
  assert.equal(modRuns.length, 1, "only the valid invocation ran");
});

test("mods lists analysis mods with kind · produces → axis alongside attribution", () => {
  registerRecipe({
    name: "stub-analysis", kind: "analysis", produces: "per-point-scalar", axis: "opacity",
    code: "def compute(d, t):\n    return []", origin: "workspace", author: "Example Author",
  });
  registerRecipe({
    name: "stub-series", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d, t):\n    return []", origin: "workspace",
  });
  const { registry } = makeRegistry();
  const lines = registry.runCommand("mods").message.split("\n");
  assert.ok(lines.includes("workspace:"), "workspace mods group separately from built-ins");
  assert.ok(lines.includes("  stub-analysis — analysis · per-point-scalar → opacity · by Example Author"),
    lines.join("|"));
  assert.ok(lines.includes("  stub-series — analysis · per-frame-series"), lines.join("|"));
  assert.ok(lines.indexOf("built-in:") < lines.indexOf("workspace:"),
    "registration order groups built-ins first");
});

// -- rm: the destructive verb's resolution/refusal/prompt buckets -----------------

test("rm: usage, nomatch, and the built-in refusal — none of them arm a prompt", () => {
  const { registry, rmArms } = makeRegistry();
  const bare = registry.runCommand("rm");
  assert.equal(bare.status, "error");
  assert.match(bare.message, /rm <name> \[\+ <name>…\] or rm all/);
  const nomatch = registry.runCommand("rm nothere");
  assert.equal(nomatch.status, "nomatch");
  assert.match(nomatch.message, /no mod named "nothere"[\s\S]*nothing to delete/);
  assert.equal(nomatch.confirm, undefined);
  // a registered BUILT-IN stub stands in for what `rainbow` used to be: the
  // codebase ships none, but rm's refusal path for one must stay covered
  registerRecipe({
    name: "zz_rm_builtin", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d,t):\n pass", origin: "built-in",
  });
  const builtin = registry.runCommand("rm zz_rm_builtin");
  unregisterRecipe("zz_rm_builtin");
  assert.equal(builtin.status, "error");
  assert.match(builtin.message,
    /"zz_rm_builtin" is built-in — code, not a file; it cannot be deleted[\s\S]*nothing to delete/);
  assert.equal(builtin.confirm, undefined, "refusal-only never prompts");
  // `rm all` against whatever the SHARED module registry currently holds
  // (earlier tests register workspace stubs): empty → nomatch, else a
  // prompt listing exactly the workspace names
  const ws = listRecipes().filter((m) => m.origin !== "built-in").map((m) => m.name);
  const allRes = registry.runCommand("rm all");
  if (ws.length === 0) {
    assert.equal(allRes.status, "nomatch");
    assert.equal(allRes.message, "no workspace mods to delete");
    assert.equal(rmArms.length, 0, "nothing was ever armed");
  } else {
    assert.equal(allRes.confirm, true);
    assert.match(allRes.message, new RegExp(`will delete ${ws.length} workspace mods?: ${ws.join(", ")}`));
    assert.deepEqual(rmArms, [ws], "armed = every workspace mod, never built-ins");
  }
});

test("rm: a deletable selector prompts (confirm:true) and arms EXACTLY the workspace names", () => {
  registerRecipe({
    name: "zz_rm_a", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d,t):\n pass", origin: "workspace",
  });
  registerRecipe({
    name: "zz_rm_b", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d,t):\n pass", origin: "workspace",
  });
  registerRecipe({
    name: "zz_rm_builtin2", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d,t):\n pass", origin: "built-in",
  });
  try {
    const { registry, rmArms } = makeRegistry();
    const r = registry.runCommand("rm zz_rm_builtin2 + zz_rm_a + nothere + zz_rm_b");
    assert.equal(r.status, "ok");
    assert.equal(r.confirm, true, "the terminal arms its pending slot on this");
    assert.match(r.message, /"zz_rm_builtin2" is built-in/, "mixed selector still refuses the built-in");
    assert.match(r.message, /no mod named "nothere"/);
    assert.match(r.message, /will delete 2 workspace mods: zz_rm_a, zz_rm_b/,
      "the confirmation states EXACTLY what will be deleted");
    assert.match(r.message, /CANNOT be undone\. y\/n\?/);
    assert.deepEqual(rmArms, [["zz_rm_a", "zz_rm_b"]], "armed = the deletable names only");
  } finally {
    unregisterRecipe("zz_rm_a");
    unregisterRecipe("zz_rm_b");
    unregisterRecipe("zz_rm_builtin2");
  }
});

// -- save_rep: name validation, built-in refusal, empty scene, the write ----------

test("save_rep: usage, bad name, and the built-in refusal never write", () => {
  const { registry, saveRepCalls } = makeRegistry();
  assert.match(registry.runCommand("save_rep").message, /needs a name/);
  assert.equal(registry.runCommand("save_rep").status, "error");
  assert.match(registry.runCommand("save_rep My Rep").message, /one name, no spaces/);
  assert.match(registry.runCommand("save_rep 1bad").message, /invalid mod name/);
  const builtin = registry.runCommand("save_rep colorpoints");
  assert.equal(builtin.status, "error");
  assert.match(builtin.message, /"colorpoints" is a built-in command/);
  assert.equal(saveRepCalls.length, 0, "no refusal ever reached the writer");
});

test("save_rep: a default scene captures nothing (nomatch, no write)", () => {
  const { registry, saveRepCalls } = makeRegistry();
  const r = registry.runCommand("save_rep myrep");
  assert.equal(r.status, "nomatch");
  assert.match(r.message, /the scene is at its default look — nothing to capture/);
  assert.equal(saveRepCalls.length, 0);
});

test("save_rep: a styled scene writes a valid replayable mod and reports the count", () => {
  const { registry, ctx, saveRepCalls } = makeRegistry();
  // paint a couple of points red through the REAL color verb (writes the stub
  // buffer path is separate, so drive repSnapshot directly for the capture)
  const snap = ctx.repSnapshot();
  const color = new Float32Array(snap.color as Float32Array); // copy so we can edit
  for (const p of [0, 1]) { color[p * 3] = 1; color[p * 3 + 1] = 0; color[p * 3 + 2] = 0; }
  ctx.repSnapshot = () => ({ ...snap, color });
  const r = registry.runCommand("save_rep myrep");
  assert.equal(r.status, "ok");
  assert.match(r.message, /captured 1 command — saving as "myrep"…/);
  assert.equal(saveRepCalls.length, 1);
  assert.equal(saveRepCalls[0].name, "myrep");
  // the written source is a valid produces:commands mod carrying the capture
  const parsed = parseModFile(saveRepCalls[0].source, "workspace");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  if (parsed.ok) {
    assert.equal(parsed.mod.produces, "commands");
    assert.ok(parsed.mod.code.includes("colorpoints #0-1 #ff0000"));
  }
});

test("CommandRegistry.unregister removes a verb from dispatch and the completion pool", () => {
  const { registry } = makeRegistry();
  registry.register("zz_verb", () => ({ status: "ok", message: "hi" }), "test");
  assert.equal(registry.runCommand("zz_verb").status, "ok");
  assert.equal(registry.unregister("zz_verb"), true);
  assert.equal(registry.runCommand("zz_verb").status, "error");
  assert.match(registry.runCommand("zz_verb").message, /unknown command/);
  assert.ok(!registry.verbs().includes("zz_verb"));
});

// -- rm reconciliation: a file already gone vs a real failure (Part A) --------
test("isFileAlreadyGone: ENOENT reconciles (unregister), other errors stay registered", () => {
  assert.ok(isFileAlreadyGone("ENOENT: no such file or directory, unlink '/x/rg_all.py'"));
  assert.ok(isFileAlreadyGone("no such file"));
  // a real failure — must NOT be reconciled (leaves the mod registered)
  assert.ok(!isFileAlreadyGone("EACCES: permission denied, unlink '/x/rg.py'"));
  // the fileless-mod case (broken_ramp) is a distinct 'no file recorded' — not ENOENT
  assert.ok(!isFileAlreadyGone("no file recorded for this mod"));
});

// -- produces: commands — refusals + all-or-nothing (the macro-mod boundary) --
function macroTracker() {
  const calls = { validate: [] as string[], run: [] as string[], beginStroke: 0, endStroke: 0 };
  const ok: CommandResult = { status: "ok", message: "ok" };
  const make = (
    validate: (c: string) => CommandResult = () => ok,
    run: (c: string) => CommandResult = (c) => ({ status: "ok", message: `ran ${c}` }),
  ) => ({
    modNames: new Set(["index_ramp", "color_ab"]),
    validate: (c: string) => { calls.validate.push(c); return validate(c); },
    run: (c: string) => { calls.run.push(c); return run(c); },
    beginStroke: () => { calls.beginStroke++; },
    endStroke: () => { calls.endStroke++; },
  });
  return { calls, make };
}

test("commandMacroRefusal: rm and mod-invocation refused; scene verbs allowed", () => {
  const mods = new Set(["index_ramp", "color_ab"]);
  assert.match(commandMacroRefusal("rm all", mods)!, /rm.*not allowed/);
  assert.match(commandMacroRefusal("color_ab all", mods)!, /invoking a mod.*recursion/);
  assert.match(commandMacroRefusal("index_ramp alpha", mods)!, /recursion/);
  assert.equal(commandMacroRefusal("colorbonds alpha.group-0.* red", mods), null);
  assert.equal(commandMacroRefusal("hide beta", mods), null);
});

test("runCommandMacro refuses rm anywhere in the list — executes NOTHING", () => {
  const { calls, make } = macroTracker();
  const r = runCommandMacro("m", ["colorbonds alpha red", "rm all", "hide beta"], make());
  assert.equal(r.status, "error");
  assert.match(r.message, /refused.*rm.*not allowed.*Nothing ran/s);
  assert.equal(calls.run.length, 0, "no command executed");
  assert.equal(calls.beginStroke, 0, "no undo stroke opened");
});

test("runCommandMacro refuses invoking a mod (no recursion) — executes NOTHING", () => {
  const { calls, make } = macroTracker();
  const r = runCommandMacro("color_ab", ["colorbonds alpha red", "color_ab all"], make());
  assert.equal(r.status, "error");
  assert.match(r.message, /invoking a mod.*Nothing ran/s);
  assert.equal(calls.run.length, 0);
});

test("runCommandMacro: a parse error in the THIRD string runs ZERO commands", () => {
  const { calls, make } = macroTracker();
  const validate = (c: string): CommandResult =>
    c.includes("BAD") ? { status: "error", message: "empty segment — \"..\" not allowed" } : { status: "ok", message: "" };
  const r = runCommandMacro("m", ["colorbonds alpha red", "hide beta", "view a..b BAD"], make(validate));
  assert.equal(r.status, "error");
  assert.match(r.message, /command 3 is invalid.*Nothing ran/s);
  assert.equal(calls.run.length, 0, "ZERO commands executed — not two");
  assert.equal(calls.beginStroke, 0);
});

test("runCommandMacro: a nomatch is NOT an error — the rest still execute", () => {
  const { calls, make } = macroTracker();
  const validate = (c: string): CommandResult =>
    c.includes("nothere") ? { status: "nomatch", message: "nothing matches" } : { status: "ok", message: "" };
  const r = runCommandMacro("m", ["colorbonds alpha red", "colorbonds nothere blue"], make(validate));
  assert.equal(r.status, "ok");
  assert.equal(calls.run.length, 2, "both ran despite the nomatch");
  assert.equal(calls.beginStroke, 1);
  assert.equal(calls.endStroke, 1);
});

test("runCommandMacro: EVERY command nomatches → loud nomatch summary, not cheerful ok (Part B)", () => {
  const { calls, make } = macroTracker();
  // validate passes (labels are grammatically fine), but at RUN time each one
  // resolves to nothing — the guessed-label trap.
  const pass = (): CommandResult => ({ status: "ok", message: "" });
  const run = (): CommandResult => ({ status: "nomatch", message: "nothing matches" });
  const r = runCommandMacro("dssp", ["colorbonds polymer.C.* red", "colorbonds polymer.D.* blue"], make(pass, run));
  assert.equal(r.status, "nomatch", "all-nomatch is surfaced, not reported as success");
  assert.match(r.message, /nothing matched/i);
  assert.match(r.message, /nothing was written/i);
  assert.match(r.message, /data\.labels/, "the message points the mod at the fix");
  assert.equal(calls.run.length, 2, "it still ran everything — the batch is just empty of matches");
  assert.equal(calls.beginStroke, 1);
  assert.equal(calls.endStroke, 1, "one stroke, balanced");
});

test("runCommandMacro: a PARTIAL nomatch stays a normal ok (one match is enough)", () => {
  const { make } = macroTracker();
  const pass = (): CommandResult => ({ status: "ok", message: "" });
  const run = (c: string): CommandResult =>
    c.includes("good") ? { status: "ok", message: "colored 5 edges" } : { status: "nomatch", message: "nothing matches" };
  const r = runCommandMacro("m", ["colorbonds good red", "colorbonds nothere blue"], make(pass, run));
  assert.equal(r.status, "ok", "one real match keeps the macro a success");
  assert.match(r.message, /ran 2 commands/);
});

test("runCommandMacro: all valid → runs all in ONE stroke, reports per-command outcomes", () => {
  const { calls, make } = macroTracker();
  const r = runCommandMacro("look", ["colorbonds alpha red", "colorbonds beta blue"], make());
  assert.equal(r.status, "ok");
  assert.deepEqual(calls.run, ["colorbonds alpha red", "colorbonds beta blue"]);
  assert.equal(calls.beginStroke, 1, "exactly one stroke opened");
  assert.equal(calls.endStroke, 1, "and closed once → one undo stroke");
  assert.match(r.message, /ran 2 commands \(one undo stroke\)/);
  assert.match(r.message, /colorbonds alpha red → ran colorbonds alpha red/);
});

// ================== the code that RUNS is the code that was APPROVED ==========
// write_mod is a GATED tool: the human is shown a mod's FULL source and approves
// it. So the viewer must run the code it was last handed. It did not: installMods
// guarded with "is this name already a verb", which is true of every already-
// installed mod — so a mod re-pushed under its own name collided with ITSELF, was
// skipped, and both caches (the recipe entry holding mod.code, and the command
// handler CLOSING OVER the mod object) kept version 1. The human approved version
// B; version A ran. delete_mod + rewrite worked only because it is the one path
// that evicts those caches.

/** Install into a real registry + the real recipe registry, exactly as main.ts
 * wires it — the deps are the only thing main.ts adds. */
function makeInstaller() {
  const made = makeRegistry();
  const install = (mods: unknown) =>
    installModList(mods, {
      isBuiltin: (name) => made.registry.isBuiltin(name),
      install: (mod) => {
        registerRecipe(mod);
        made.registry.register(mod.name, makeAnalysisModHandler(made.ctx, mod), "analysis mod");
      },
    });
  return { ...made, install };
}

const modV = (name: string, code: string): AnalysisMod => ({
  kind: "analysis", name, produces: "commands", origin: "workspace",
  description: "overwrite fixture", code,
});

test("§3.1 a re-pushed mod RUNS ITS NEW CODE — not the version it was first registered with", () => {
  const { registry, install, modRunCode } = makeInstaller();
  const A = modV("zz_over", "def compute(d,t): return ['A']");
  const B = modV("zz_over", "def compute(d,t): return ['B']");
  try {
    assert.deepEqual(install([A]), { installed: ["zz_over"], skipped: [] , channelCollisions: [], dependencyIssues: [] });
    registry.runCommand("zz_over c0");
    assert.deepEqual(modRunCode, [A.code], "version A runs first — the baseline");

    // The overwrite: same name, new code, NO delete in between. This is exactly
    // what write_mod does, and it is where the gate used to break.
    assert.deepEqual(install([B]), { installed: ["zz_over"], skipped: [] , channelCollisions: [], dependencyIssues: [] },
      "a re-push is an INSTALL, not a self-collision to skip");
    registry.runCommand("zz_over c0");
    assert.deepEqual(modRunCode, [A.code, B.code],
      "THE INVARIANT: the handler now ships version B — the code the human approved");

    // Both caches, not just one: a stale recipe entry is the same bug wearing a
    // different hat (run_mod reads mod.code straight off the registry).
    const entry = getRecipe("zz_over");
    assert.equal(entry?.kind === "analysis" ? entry.code : null, B.code,
      "the recipe registry holds version B too");
  } finally {
    unregisterRecipe("zz_over");
  }
});

test("§3.3 a mod named after a BUILT-IN is still refused — and the built-in still works", () => {
  const { registry, install, colorOps } = makeInstaller();
  // `colorpoints` stands where `rainbow` used to: a real BUILT-IN VERB (the
  // guard is about the command registry's sealed names, and retiring rainbow
  // freed that name — a mod may legitimately claim it now).
  const hostile = modV("colorpoints", "def compute(d,t): return ['pwned']");
  const outcome = install([hostile]);
  assert.deepEqual(outcome.installed, [], "nothing installed");
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0].name, "colorpoints");
  assert.match(outcome.skipped[0].reason, /built-in/, "and it says WHY");

  // the reason the guard exists: the built-in must be untouched
  const r = registry.runCommand("colorpoints c0 red");
  assert.equal(r.status, "ok", r.message);
  assert.equal(colorOps.length, 1, "the real colorpoints ran — its handler was never replaced");
  assert.equal(getRecipe("colorpoints"), undefined, "and no mod entry was created for it");
});

test("a mod's own verb is NOT a built-in — sealing draws the line where the factory ends", () => {
  const { registry, install } = makeInstaller();
  try {
    assert.ok(registry.isBuiltin("colorpoints") && registry.isBuiltin("bake") && registry.isBuiltin("help"));
    install([modV("zz_over", "def compute(d,t): return []")]);
    assert.ok(registry.verbs().includes("zz_over"), "it IS a verb");
    assert.ok(!registry.isBuiltin("zz_over"), "…but never a built-in — which is what makes the re-push legal");
  } finally {
    unregisterRecipe("zz_over");
  }
});

test("§3.2 modInstallReport is TRUTHFUL — it never reports a registration that did not happen", () => {
  const skipped = { installed: [], skipped: [{ name: "colorpoints", reason: '"colorpoints" is a built-in command' }] , channelCollisions: [], dependencyIssues: [] };
  const refused = modInstallReport(skipped, "colorpoints");
  assert.equal(refused.status, "error", "a skip is an ERROR the tool can surface, not a silent line");
  assert.match(refused.message, /did NOT register/);
  assert.match(refused.message, /built-in command/, "the reason travels with it");

  const good = modInstallReport({ installed: ["rg"], skipped: [] , channelCollisions: [], dependencyIssues: [] }, "rg");
  assert.equal(good.status, "ok");
  assert.match(good.message, /registered mod "rg"/);

  // the file was written but never reached the registry at all (malformed on
  // re-parse, or the viewer was not ready): still not a success.
  const absent = modInstallReport({ installed: ["other"], skipped: [] , channelCollisions: [], dependencyIssues: [] }, "rg");
  assert.equal(absent.status, "error");
  assert.match(absent.message, /not among the mods loaded from disk/);

  // P-2: a channel-name collision surfaces on the ok line for the colliding mod
  const clash = modInstallReport(
    { installed: ["heat_b", "heat_a"], skipped: [], channelCollisions: [{ channel: "heat", mods: ["heat_a", "heat_b"] }], dependencyIssues: [] },
    "heat_b");
  assert.equal(clash.status, "ok", "both mods still register — a warning, not a refusal");
  assert.match(clash.message, /registered mod "heat_b"/);
  assert.match(clash.message, /channel "heat" is also declared by heat_a/);
});

test("P-2: installModList detects a channel-name collision across the pushed set", () => {
  const { install } = makeInstaller();
  const chMod = (name: string, channel: string) => ({
    name, kind: "analysis" as const, produces: "channel" as const, channel,
    origin: "workspace" as const, code: "def compute(d,t): return {'values': [], 'components': 1}",
  });
  const outcome = install([chMod("heat_a", "heat"), chMod("heat_b", "heat"), chMod("flow", "flow_dir")]);
  assert.deepEqual([...outcome.installed].sort(), ["flow", "heat_a", "heat_b"], "all three register");
  assert.deepEqual(outcome.channelCollisions, [{ channel: "heat", mods: ["heat_a", "heat_b"] }]);
});

test("P-3: installModList detects unsatisfiable requires-channel at registration; report warns", () => {
  const { install } = makeInstaller();
  const provider = (name: string, channel: string) => ({
    name, kind: "analysis" as const, produces: "channel" as const, channel,
    origin: "workspace" as const, code: "def compute(d,t): return {'values': [], 'components': 1}",
  });
  const consumer = (name: string, requiresChannel: string) => ({
    name, kind: "analysis" as const, produces: "commands" as const, requiresChannel,
    origin: "workspace" as const, code: "def compute(d,t): return []",
  });
  // a satisfied dependency → no issue; an orphan → a named issue
  const outcome = install([provider("flow", "flow_dir"), consumer("ok", "flow_dir"), consumer("orphan", "ghost")]);
  assert.deepEqual(outcome.dependencyIssues.map((d) => d.mod), ["orphan"], "only the orphan is an issue");
  assert.match(outcome.dependencyIssues[0].issue, /no registered mod declares it/);
  // the report warns on the ok line for the requiring mod, still registered
  const rep = modInstallReport(outcome, "orphan");
  assert.equal(rep.status, "ok", "the orphan still registers — a warning, not a refusal");
  assert.match(rep.message, /registered mod "orphan".*can't auto-run its provider.*no registered mod declares it/);
});

test("P-3: a requirement satisfied by a LIVE dataset channel is NOT a dependency issue", () => {
  const consumer = (name: string, requiresChannel: string): AnalysisMod => ({
    name, kind: "analysis", produces: "commands", requiresChannel, origin: "workspace",
    code: "def compute(d,t): return []",
  });
  const registered: AnalysisMod[] = [];
  const deps: import("../webview/commands.ts").ModInstallDeps = {
    isBuiltin: () => false,
    install: (m) => { registerRecipe(m); registered.push(m); },
    liveChannels: () => ["energy", "mass"], // a base dataset channel, no mod provider
  };
  // "energy" is a live channel (not a mod) → no issue; "ghost" has no provider → issue
  const outcome = installModList([consumer("uses_live", "energy"), consumer("uses_ghost", "ghost")], deps);
  assert.deepEqual(outcome.dependencyIssues.map((d) => d.mod), ["uses_ghost"],
    "a requirement met by a live channel is fine; only the true orphan is flagged");
  for (const m of registered) unregisterRecipe(m.name);
});

test("a malformed entry in a push is skipped WITH a reason, never silently dropped", () => {
  const { install } = makeInstaller();
  const outcome = install([{ name: "half", kind: "analysis" }, { kind: "analysis", code: "x" }]);
  assert.deepEqual(outcome.installed, []);
  assert.deepEqual(outcome.skipped.map((s) => s.name), ["half", "(unnamed)"]);
  assert.ok(outcome.skipped.every((s) => /well-formed/.test(s.reason)));
});

// -- the produced arm: %group targets + point-target produced matching -------------

/** makeRegistry plus a PRODUCED fixture over the same 3-point scene:
 *   %hb   ids [0,1] — pairs [0,1] (inside c0) and [1,2] (crossing into c1)
 *   %far  id  [2]   — pair  [0,2] (crossing; no header edge links 0-2)
 *   %off  id  [3]   — INACTIVE (its declaration walked back)
 *   %none          — declared but EMPTY (count 0)
 * The header edges stay [[0,1],[1,2]], so every contained/incident case is
 * decidable across BOTH id spaces from this one scene. */
function makeProducedFixture() {
  const fx = makeRegistry();
  fx.produced.groups.push(
    { name: "hb", baseId: 0, count: 2, active: true },
    { name: "far", baseId: 2, count: 1, active: true },
    { name: "off", baseId: 3, count: 1, active: false },
    { name: "none", baseId: 4, count: 0, active: true },
  );
  fx.produced.pairs.set(0, [0, 1]);
  fx.produced.pairs.set(1, [1, 2]);
  fx.produced.pairs.set(2, [0, 2]);
  fx.produced.pairs.set(3, [0, 1]);
  return fx;
}

test("%group: styles EXACTLY that group's produced edges — header edges untouched", () => {
  const fx = makeProducedFixture();
  const res = fx.registry.runCommand("colorbonds %hb red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 2 produced edges red");
  assert.deepEqual(fx.producedOps, [{ kind: "color", ids: [0, 1], value: [1, 0, 0] }]);
  assert.deepEqual(fx.edgeOps, [], "no header-edge write");
  assert.deepEqual(fx.strokeEvents, [], "one family wrote — no combined stroke opened");
});

test("%group: the whole family writes through its produced writer", () => {
  const fx = makeProducedFixture();
  assert.equal(fx.registry.runCommand("bondsize %far 4").message, "set 1 produced edges to size 4");
  assert.equal(fx.registry.runCommand("dashbonds %hb 0.6").message, "set 2 produced edges to dash 0.6");
  assert.equal(fx.registry.runCommand("bondopacity %hb 0.25").message, "set 2 produced edges to opacity 0.25");
  assert.deepEqual(fx.producedOps.map((o) => [o.kind, o.ids, o.value]), [
    ["size", [2], 4],
    ["dash", [0, 1], 0.6],
    ["opacity", [0, 1], 0.25],
  ]);
  assert.deepEqual(fx.sizeOps, [], "no header write anywhere");
  assert.deepEqual(fx.dashOps, []);
  assert.deepEqual(fx.opacityOps, []);
});

test("%group: unions via '+'/',' dedupe ids; a repeated group counts once", () => {
  const fx = makeProducedFixture();
  assert.equal(fx.registry.runCommand("colorbonds %hb + %far red").message, "colored 3 produced edges red");
  assert.deepEqual(fx.producedOps[0].ids, [0, 1, 2]);
  fx.producedOps.length = 0;
  assert.equal(fx.registry.runCommand("colorbonds %hb,%hb red").message, "colored 2 produced edges red");
  assert.deepEqual(fx.producedOps[0].ids, [0, 1]);
});

test("%group: unknown / inactive / empty groups are HONEST nomatches, nothing written", () => {
  const fx = makeProducedFixture();
  const unknown = fx.registry.runCommand("colorbonds %nope red");
  assert.equal(unknown.status, "nomatch");
  assert.match(unknown.message, /^no group %nope — declared groups: %hb, %far, %off, %none$/);
  const inactive = fx.registry.runCommand("dashbonds %off 1");
  assert.equal(inactive.status, "nomatch");
  assert.match(inactive.message, /%off is inactive .*undone.*re-run the mod/);
  const empty = fx.registry.runCommand("bondsize %none 2");
  assert.equal(empty.status, "nomatch");
  assert.equal(empty.message, "group %none has no edges");
  // and with NO groups declared, the unknown wording says so
  const bare = makeRegistry();
  assert.match(bare.registry.runCommand("colorbonds %x red").message,
    /^no group %x — no produced-edge groups are declared$/);
  assert.deepEqual(fx.producedOps, []);
  assert.deepEqual(fx.edgeOps, []);
});

test("point target: ONE invocation styles both id spaces in ONE combined stroke", () => {
  const fx = makeProducedFixture();
  // c0 = {0,1}: contained header edge 0 ([0,1]); contained produced id 0
  const res = fx.registry.runCommand("dashbonds c0 2");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "set 1 edges + 1 produced edges to dash 2");
  assert.deepEqual(fx.dashOps, [{ ids: [0], dash: 2 }]);
  assert.deepEqual(fx.producedOps, [{ kind: "dash", ids: [0], value: 2 }]);
  assert.deepEqual(fx.strokeEvents, ["begin", "end"], "both families → ONE ctx stroke");
});

test("point target: contained vs incident applies to produced edges IDENTICALLY", () => {
  const fx = makeProducedFixture();
  // contained in c0={0,1}: produced id 0 only
  fx.registry.runCommand("colorbonds c0 red");
  assert.deepEqual(fx.producedOps.at(-1)?.ids, [0]);
  // incident to c0: produced 0 ([0,1]), 1 ([1,2] via 1), 2 ([0,2] via 0) —
  // and NEVER the inactive id 3, though its pair [0,1] would match
  const res = fx.registry.runCommand("colorbondsof c0 red");
  assert.equal(res.message, "colored 2 edges + 3 produced edges red");
  assert.deepEqual(fx.producedOps.at(-1)?.ids, [0, 1, 2]);
});

test("point target: produced-ONLY matches write without a combined stroke", () => {
  const fx = makeProducedFixture();
  // {point 0} ∪ c1 = {0,2}: NO header edge is contained ([0,1] needs 1;
  // [1,2] needs 1) but produced %far's [0,2] is — the produced-only branch
  const res = fx.registry.runCommand("colorbonds c0.g0.s0.a + c1 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 1 produced edges red");
  assert.deepEqual(fx.producedOps, [{ kind: "color", ids: [2], value: [1, 0, 0] }]);
  assert.deepEqual(fx.edgeOps, []);
  assert.deepEqual(fx.strokeEvents, [], "one family wrote — no combined stroke");
});

test("bicolorbonds: the produced arm snapshots endpoint colors via activePairs", () => {
  const fx = makeProducedFixture();
  // %far: pair [0,2] — A half from point 0's color, B from point 2's
  const res = fx.registry.runCommand("bicolorbonds %far");
  assert.equal(res.message, "bicolored 1 produced edges from their endpoints' colors");
  assert.equal(fx.producedOps.length, 1);
  const op = fx.producedOps[0];
  assert.equal(op.kind, "ends");
  assert.deepEqual(op.ids, [2]);
  assert.deepEqual(op.a?.map((v) => Math.round(v * 10) / 10), [0.1, 0.2, 0.3]);
  assert.deepEqual(op.b?.map((v) => Math.round(v * 10) / 10), [0.7, 0.8, 0.9]);
  assert.deepEqual(fx.endsOps, [], "no header-edge ends write for a %group");
  // a point target snapshots BOTH spaces in one stroke
  const both = fx.registry.runCommand("bicolorbonds c0");
  assert.equal(both.message, "bicolored 1 edges + 1 produced edges from their endpoints' colors");
  assert.deepEqual(fx.strokeEvents, ["begin", "end"]);
  assert.equal(fx.endsOps.length, 1);
});

test("no produced edges: every edge verb runs the EXACT legacy path (byte-identical message, no stroke)", () => {
  const fx = makeRegistry(); // produced fixture EMPTY
  assert.equal(fx.registry.runCommand("colorbonds c0 red").message, "colored 1 edges red");
  assert.equal(fx.registry.runCommand("bondsize c0 3").message, "set 1 edges to size 3");
  assert.equal(fx.registry.runCommand("dashbonds c0 1.5").message, "set 1 edges to dash 1.5");
  assert.equal(fx.registry.runCommand("bondopacity c0 0.5").message, "set 1 edges to opacity 0.5");
  assert.equal(fx.registry.runCommand("bicolorbonds c0").message,
    "bicolored 1 edges from their endpoints' colors");
  assert.deepEqual(fx.producedOps, [], "no produced write anywhere");
  assert.deepEqual(fx.strokeEvents, [], "no combined stroke ever opened");
});

test("%group means nothing outside the edge family — a point verb nomatches, writes nothing", () => {
  const fx = makeProducedFixture();
  // "%hb" rides the point grammar as an ordinary (unmatched) label token, so
  // the refusal is the standard nomatch — honest: nothing resolved, nothing
  // written, and the produced ids were never consulted.
  const r = fx.registry.runCommand("colorpoints %hb red");
  assert.equal(r.status, "nomatch", JSON.stringify(r));
  assert.equal(r.message, 'nothing matches "%hb"');
  assert.deepEqual(fx.producedOps, []);
  assert.deepEqual(fx.colorOps, []);
});

// -- completeCommand: the argument-aware completion dispatcher --------------------

/** A registry + ctx with one PARAMIZED analysis mod installed under its own
 * verb (recipe registry AND command registry, like a real push), plus the
 * teardown that keeps the module-global recipe registry clean. */
function makeCompletionFixture() {
  const fx = makeRegistry();
  const mod: AnalysisMod = {
    name: "compmod", kind: "analysis", produces: "commands", origin: "workspace",
    params: [
      { name: "floor", type: "number", default: 0.5 },
      { name: "flag", type: "boolean", default: false },
      { name: "label", type: "string" }, // required
    ],
    code: "def compute(data, target_indices, params):\n    return []",
  };
  registerRecipe(mod);
  // a BUILT-IN mod stub: rm's completion pool must exclude built-ins, and with
  // `rainbow` retired the codebase ships none — without a stub that assertion
  // would pass vacuously.
  registerRecipe({
    name: "zz_comp_builtin", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d,t):\n pass", origin: "built-in",
  });
  fx.registry.register("compmod", makeAnalysisModHandler(fx.ctx, mod), "test mod");
  const comp = (text: string, cursor = text.length) =>
    completeCommand(fx.ctx, fx.registry, text, cursor);
  return {
    ...fx, comp,
    done: () => { unregisterRecipe("compmod"); unregisterRecipe("zz_comp_builtin"); },
  };
}

test("completeCommand: verb position is unchanged — and a mod's own verb completes there", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    assert.deepEqual(comp("vie"), { start: 0, candidates: ["view"], applied: "w " });
    assert.deepEqual(comp("compm"), { start: 0, candidates: ["compmod"], applied: "od " });
    // cursor inside the first word: still the verb slot (text beyond is ignored)
    assert.deepEqual(comp("compm alpha", 5), { start: 0, candidates: ["compmod"], applied: "od " });
    assert.deepEqual(comp("zoom").candidates, []);
  } finally { done(); }
});

test("completeCommand: target slots still complete through the dispatcher (regression)", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // an ordinary verb's target — the pre-dispatch behavior, untouched
    assert.deepEqual(comp("view c0"), { start: 5, candidates: ["g0"], applied: "." });
    // a mod invocation's TARGET slot (no ? yet) is target text too
    assert.deepEqual(comp("compmod c0"), { start: 8, candidates: ["g0"], applied: "." });
    // a numeric value slot stays a no-op (nothing enumerable)
    assert.deepEqual(comp("pointsize c0 3").candidates, []);
  } finally { done(); }
});

test("completeCommand: a #e chunk completes the value slot for EDGE verbs only", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // colorbonds accepts #e at runtime → the color slot after it completes
    const edge = comp("colorbonds #e0 re");
    assert.ok(edge.candidates.includes("red"), JSON.stringify(edge));
    // colorpoints REFUSES #e at runtime → its value slot after a #e chunk is
    // inert (no candidates offered for a command that cannot run)
    assert.deepEqual(comp("colorpoints #e0 re").candidates, []);
    // a point target still completes colorpoints' value slot (the gate is
    // scoped to the #e chunk, not the verb's completion generally)
    assert.ok(comp("colorpoints c0 re").candidates.includes("red"));
  } finally { done(); }
});

test("completeCommand: %<TAB> offers LIVE produced-group names — edge verbs only, active only", () => {
  const fx = makeProducedFixture();
  const comp = (text: string, cursor = text.length) =>
    completeCommand(fx.ctx, fx.registry, text, cursor);
  // the bare % token: every ACTIVE group (inactive %off would nomatch at
  // runtime, so it is never offered), kind "group", start after the %
  const bare = comp("colorbonds %");
  assert.equal(bare.kind, "group");
  assert.deepEqual(bare.candidates, ["far", "hb", "none"]); // settled (sorted) pool
  assert.equal(bare.start, "colorbonds %".length);
  // a prefix narrows and settles
  const pre = comp("dashbonds %f");
  assert.deepEqual(pre.candidates, ["far"]);
  assert.equal(pre.applied, "ar");
  // a union's NEWEST spec completes (the scan starts after the last +/,)
  assert.deepEqual(comp("colorbonds %hb+%f").candidates, ["far"]);
  // the whole numeric/bicolor family routes the same %-aware target slot
  assert.deepEqual(comp("bondsize %h").candidates, ["hb"]);
  assert.deepEqual(comp("bicolorbonds %n").candidates, ["none"]);
  // NON-edge verbs never offer group names — %group cannot run there
  assert.ok(!comp("colorpoints %h").candidates.includes("hb"));
});

test("completeCommand: a %group chunk completes the value slot for EDGE verbs only", () => {
  const fx = makeProducedFixture();
  const comp = (text: string, cursor = text.length) =>
    completeCommand(fx.ctx, fx.registry, text, cursor);
  // colorbonds accepts %group at runtime → the color slot after it completes
  const after = comp("colorbonds %hb re");
  assert.ok(after.candidates.includes("red"), JSON.stringify(after));
  // (a "%hb" chunk PARSES as an unmatched label token in the point grammar,
  // so colorpoints' value slot completes after it exactly as after any
  // parseable-but-unmatched word — the runtime nomatch is the honest gate,
  // unlike "#e0" which does not parse as a point target at all)
  assert.ok(comp("colorpoints %hb re").candidates.includes("red"));
  // numeric slots after a %group chunk stay unenumerable no-ops
  assert.deepEqual(comp("bondsize %hb 3").candidates, []);
});

test("completeCommand: ?param NAMES — pool, prefix extension, unique appends '='", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // all declared names, sorted, kind "param"
    assert.deepEqual(comp("compmod c0 ?"),
      { start: 12, candidates: ["flag", "floor", "label"], applied: "", kind: "param" });
    // partial → common-prefix extension (flag/floor share "fl")
    assert.deepEqual(comp("compmod c0 ?f"),
      { start: 12, candidates: ["flag", "floor"], applied: "l", kind: "param" });
    // unique → the remainder plus "="
    assert.deepEqual(comp("compmod c0 ?flo"),
      { start: 12, candidates: ["floor"], applied: "or=", kind: "param" });
    // exact name → just the "="
    assert.deepEqual(comp("compmod c0 ?floor"),
      { start: 12, candidates: ["floor"], applied: "=", kind: "param" });
  } finally { done(); }
});

test("completeCommand: chaining excludes names already used in EARLIER segments", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    assert.deepEqual(comp("compmod c0 ?floor=0.8 ?").candidates, ["flag", "label"]);
    // the used name no longer completes
    assert.deepEqual(comp("compmod c0 ?floor=0.8 ?flo").candidates, []);
    // ...but the still-unused prefix sibling does
    assert.deepEqual(comp("compmod c0 ?floor=0.8 ?fl"),
      { start: 23, candidates: ["flag"], applied: "ag=", kind: "param" });
  } finally { done(); }
});

test("completeCommand: ?param VALUES — boolean enumerates, number offers its default, string is a no-op", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // boolean: the two literals (sorted — the one shared settle path). An EMPTY
    // value completes the WHOLE pool, no typed prefix needed.
    assert.deepEqual(comp("compmod c0 ?flag="),
      { start: 17, candidates: ["false", "true"], applied: "", kind: "value" });
    assert.deepEqual(comp("compmod c0 ?flag=t"),
      { start: 17, candidates: ["true"], applied: "rue", kind: "value" });
    // number WITH a default: an empty slot offers (and Tabs in) the default — the
    // lone unique candidate, so it auto-applies and prints no list.
    assert.deepEqual(comp("compmod c0 ?floor="),
      { start: 18, candidates: ["0.5"], applied: "0.5", kind: "value" });
    // a matching prefix still narrows/extends; a non-matching one is empty
    assert.deepEqual(comp("compmod c0 ?floor=0.").candidates, ["0.5"]);
    assert.deepEqual(comp("compmod c0 ?floor=9").candidates, []);
    // string values stay unenumerable — empty, never a guess
    assert.deepEqual(comp("compmod c0 ?label=").candidates, []);
    // an unknown name's value slot is inert too
    assert.deepEqual(comp("compmod c0 ?bogus=").candidates, []);
  } finally { done(); }
});

test("completeCommand: ?param VALUES — a number param WITHOUT a default offers nothing", () => {
  // a REQUIRED number param (no default) has no suggestion to make — its empty
  // value slot stays an inert no-op (never invents a guess).
  const fx = makeRegistry();
  const mod: AnalysisMod = {
    name: "reqnum", kind: "analysis", produces: "commands", origin: "workspace",
    params: [{ name: "n", type: "number" }], // required, no default
    code: "def compute(data, target_indices, params):\n    return []",
  };
  registerRecipe(mod);
  fx.registry.register("reqnum", makeAnalysisModHandler(fx.ctx, mod), "test mod");
  const comp = (text: string) => completeCommand(fx.ctx, fx.registry, text, text.length);
  try {
    assert.deepEqual(comp("reqnum c0 ?n=").candidates, []);
  } finally { unregisterRecipe("reqnum"); }
});

test("completeCommand: ?param VALUES — a choice param completes its options; empty offers all, prefix filters", () => {
  // a mod with a choice parameter, installed under its own verb (its options are
  // the value vocabulary; VALIDATION restricts to the set, completion offers it).
  const fx = makeRegistry();
  const mod: AnalysisMod = {
    name: "scopemod", kind: "analysis", produces: "commands", origin: "workspace",
    params: [{ name: "scope", type: "choice", default: "within", options: ["within", "any"] }],
    code: "def compute(data, target_indices, params):\n    return []",
  };
  registerRecipe(mod);
  fx.registry.register("scopemod", makeAnalysisModHandler(fx.ctx, mod), "test mod");
  const comp = (text: string) => completeCommand(fx.ctx, fx.registry, text, text.length);
  try {
    // empty value → ALL options, sorted, kind "value" (no typed prefix needed)
    assert.deepEqual(comp("scopemod c0 ?scope="),
      { start: 19, candidates: ["any", "within"], applied: "", kind: "value" });
    // a prefix narrows and extends to the unique match
    assert.deepEqual(comp("scopemod c0 ?scope=w"),
      { start: 19, candidates: ["within"], applied: "ithin", kind: "value" });
    assert.deepEqual(comp("scopemod c0 ?scope=a"),
      { start: 19, candidates: ["any"], applied: "ny", kind: "value" });
    // a non-option prefix is empty (nothing to guess)
    assert.deepEqual(comp("scopemod c0 ?scope=z").candidates, []);
  } finally { unregisterRecipe("scopemod"); }
});

test("completeCommand: ?param VALUES — a hint param SUGGESTS its values (kind 'suggestion') and accepts others", () => {
  // The pair a `choice` cannot state: the token `auto` OR any number. The
  // completion offers the literals; VALIDATION lets anything through, and the
  // two must be visibly different or the candidate list misreports the domain —
  // hence kind "suggestion" (the terminal's header for it says any value is
  // accepted) against a choice's exhaustive "value".
  const fx = makeRegistry();
  const mod: AnalysisMod = {
    name: "hintmod", kind: "analysis", produces: "commands", origin: "workspace",
    params: [{ name: "at", type: "hint", default: "auto", options: ["auto", "always"] }],
    code: "def compute(data, target_indices, params):\n    return []",
  };
  registerRecipe(mod);
  fx.registry.register("hintmod", makeAnalysisModHandler(fx.ctx, mod), "test mod");
  const comp = (text: string) => completeCommand(fx.ctx, fx.registry, text, text.length);
  try {
    // empty value → ALL suggestions, sorted, kind "suggestion" — same pool
    // shape and same settle path as a choice, one honest label apart
    assert.deepEqual(comp("hintmod c0 ?at="),
      { start: 15, candidates: ["always", "auto"], applied: "a", kind: "suggestion" });
    // a prefix narrows and extends to the unique match
    assert.deepEqual(comp("hintmod c0 ?at=au"),
      { start: 15, candidates: ["auto"], applied: "to", kind: "suggestion" });
    // a value OUTSIDE the suggestions completes nothing — a suggesting slot
    // still never invents a guess
    assert.deepEqual(comp("hintmod c0 ?at=7").candidates, []);
    // ...but it RUNS. The completion pool is advisory; only the parse decides.
    const off = parseModParams(mod, "c0 ?at=7");
    assert.ok(!("status" in off), JSON.stringify(off));
    if (!("status" in off)) assert.deepEqual(off.params, { at: "7" });
    const listed = parseModParams(mod, "c0 ?at=always");
    if (!("status" in listed)) assert.deepEqual(listed.params, { at: "always" });
    // nothing typed → the first suggestion is the default
    const bare = parseModParams(mod, "c0");
    if (!("status" in bare)) assert.deepEqual(bare.params, { at: "auto" });
  } finally { unregisterRecipe("hintmod"); }
});

test("completeCommand: a hint and a choice with the SAME list differ in kind and in what they accept", () => {
  // The one-line difference, pinned side by side: the declaration shape is
  // identical, so the TYPE is the only thing carrying restrict-vs-suggest —
  // through completion (kind) and through validation (refusal).
  const fx = makeRegistry();
  const opts = ["auto", "always"];
  const hintMod: AnalysisMod = {
    name: "hintpair", kind: "analysis", produces: "commands", origin: "workspace",
    params: [{ name: "at", type: "hint", default: "auto", options: [...opts] }],
    code: "def compute(data, target_indices, params):\n    return []",
  };
  const choiceMod: AnalysisMod = { ...hintMod, name: "choicepair",
    params: [{ name: "at", type: "choice", default: "auto", options: [...opts] }] };
  registerRecipe(hintMod);
  registerRecipe(choiceMod);
  fx.registry.register("hintpair", makeAnalysisModHandler(fx.ctx, hintMod), "test mod");
  fx.registry.register("choicepair", makeAnalysisModHandler(fx.ctx, choiceMod), "test mod");
  const comp = (text: string) => completeCommand(fx.ctx, fx.registry, text, text.length);
  try {
    // SAME candidates...
    assert.deepEqual(comp("hintpair c0 ?at=").candidates, comp("choicepair c0 ?at=").candidates);
    // ...DIFFERENT kind (the header the terminal prints is the whole difference
    // the user sees between an exhaustive list and a suggested one)
    assert.equal(comp("hintpair c0 ?at=").kind, "suggestion");
    assert.equal(comp("choicepair c0 ?at=").kind, "value");
    // ...and different acceptance
    assert.ok(!("status" in parseModParams(hintMod, "c0 ?at=7")), "the hint accepts an unlisted value");
    const refused = parseModParams(choiceMod, "c0 ?at=7");
    assert.ok("status" in refused && refused.status === "error", "the choice still REFUSES it");
    if ("status" in refused) assert.match(refused.message, /must be one of auto, always/);
  } finally { unregisterRecipe("hintpair"); unregisterRecipe("choicepair"); }
});

test("completeCommand: ?param VALUES — a color param completes CSS names, exactly like the color slot", () => {
  // a mod with a color parameter, installed under its own verb (NOT the shared
  // fixture, whose NAME assertions would shift). Its ?c= value slot must reuse
  // the color-argument slot's pool + settle path verbatim.
  const fx = makeRegistry();
  const mod: AnalysisMod = {
    name: "tintmod", kind: "analysis", produces: "commands", origin: "workspace",
    params: [
      { name: "c", type: "color", default: "green" },
      { name: "on", type: "boolean", default: false }, // a boolean sibling — no regression
    ],
    code: "def compute(data, target_indices, params):\n    return []",
  };
  registerRecipe(mod);
  fx.registry.register("tintmod", makeAnalysisModHandler(fx.ctx, mod), "test mod");
  const comp = (text: string, cursor = text.length) => completeCommand(fx.ctx, fx.registry, text, cursor);
  try {
    // ?c=li → the "li" CSS names, sorted, kind "value" — the SAME candidates the
    // colorpoints/background color slot yields for "li" (single-sourced pool).
    const liCandidates = [
      "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray",
      "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen",
      "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue",
      "lightyellow", "lime", "limegreen", "linen",
    ];
    assert.deepEqual(comp("tintmod c0 ?c=li"),
      { start: 14, candidates: liCandidates, applied: "", kind: "value" });
    // includes lightgreen and lime, as expected
    assert.ok(liCandidates.includes("lightgreen") && liCandidates.includes("lime"));
    // the color-param pool IS the color-argument slot's pool (proves single-source)
    assert.deepEqual(comp("tintmod c0 ?c=li").candidates, comp("colorpoints c0 li").candidates);
    // a unique prefix extends + no separator (a color slot appends nothing)
    assert.deepEqual(comp("tintmod c0 ?c=ste"),
      { start: 14, candidates: ["steelblue"], applied: "elblue", kind: "value" });
    // empty value → the FULL color pool, capped exactly like the color slot
    const all = comp("tintmod c0 ?c=");
    assert.match(all.candidates[0], /^\d+ matches$/);
    assert.equal(all.candidates[1], "— type to narrow");
    assert.deepEqual(all.candidates, comp("colorpoints c0 ").candidates);
    // a hex token stays open input — a no-op, exactly like the color slot
    assert.deepEqual(comp("tintmod c0 ?c=#ff").candidates, []);
    // no regression: the boolean sibling still completes true/false
    assert.deepEqual(comp("tintmod c0 ?on="),
      { start: 15, candidates: ["false", "true"], applied: "", kind: "value" });
  } finally { unregisterRecipe("tintmod"); }
});

test("completeCommand: total on junk — unbalanced quotes and malformed params, never a throw", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // the ? sits inside an unbalanced quote → NOT a param boundary → the
    // target slot's own junk handling (empty, no throw)
    assert.deepEqual(comp('compmod "abc ?floo').candidates, []);
    // a quoted region in a VALUE holds its ? — the last segment is still
    // label's (string) value slot, an inert no-op
    assert.deepEqual(comp('compmod c0 ?label="x ?').candidates, []);
    // whitespace inside a would-be name token → inert
    assert.deepEqual(comp("compmod c0 ?floor extra").candidates, []);
  } finally { done(); }
});

test("completeCommand: bake/bind channel slot — declared names, unique appends a space", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    assert.deepEqual(comp("bake c0 "),
      { start: 8, candidates: ["energy", "flow", "mass", "time"], applied: "", kind: "channel" });
    assert.deepEqual(comp("bake c0 en"),
      { start: 8, candidates: ["energy"], applied: "ergy ", kind: "channel" });
    assert.deepEqual(comp("bind c0 ma"),
      { start: 8, candidates: ["mass"], applied: "ss ", kind: "channel" });
  } finally { done(); }
});

test("completeCommand: axis slots — bake EXCLUDES offset, bind includes it, one constant apart", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    const bake = comp("bake c0 energy ");
    const bind = comp("bind c0 energy ");
    assert.equal(bake.kind, "axis");
    assert.equal(bind.kind, "axis");
    // both pools come from the channelmap constants — never a hand-copied list
    assert.deepEqual(bake.candidates,
      ([...SCALAR_AXES, ...VECTOR_AXES] as string[]).filter((a) => a !== OFFSET_AXIS).sort());
    assert.deepEqual(bind.candidates, ([...SCALAR_AXES, ...VECTOR_AXES] as string[]).sort());
    // the two differ by EXACTLY offset
    assert.deepEqual(bind.candidates.filter((a) => a !== OFFSET_AXIS), bake.candidates);
    // a partial axis token narrows; bake's pool cannot reach offset
    assert.deepEqual(comp("bind c0 flow of"),
      { start: 13, candidates: ["offset"], applied: "fset", kind: "axis" });
    assert.deepEqual(comp("bake c0 flow of").candidates, []);
    // the numeric range beyond the axis stays a no-op
    assert.deepEqual(comp("bake c0 energy color ").candidates, []);
  } finally { done(); }
});

test("completeCommand: unbind's trailing word is the axis slot (offset included)", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    assert.deepEqual(comp("unbind c0 ").candidates,
      ([...SCALAR_AXES, ...VECTOR_AXES] as string[]).sort());
    assert.equal(comp("unbind c0 ").kind, "axis");
    assert.deepEqual(comp("unbind all tracec"),
      { start: 11, candidates: ["tracecolor"], applied: "olor", kind: "axis" });
    // the target itself still completes (prior chunk empty → target slot)
    assert.deepEqual(comp("unbind c").candidates, ["c0", "c1"]);
    // past the axis there is nothing
    assert.deepEqual(comp("unbind c0 color ").candidates, []);
  } finally { done(); }
});

test("completeCommand: the + union guard keeps the cursor in the TARGET", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // a trailing + means the union continues — never the channel slot
    assert.deepEqual(comp("bake c0 + ").candidates, ["c0", "c1"]);
    assert.equal(comp("bake c0 + ").kind, undefined);
    assert.deepEqual(comp("bake c0 + c"), { start: 10, candidates: ["c0", "c1"], applied: "" });
    // once the union is complete, the NEXT chunk is the channel again
    assert.deepEqual(comp("bake c0 + c1 ").kind, "channel");
    assert.deepEqual(comp("bake c0 + c1 ").candidates, ["energy", "flow", "mass", "time"]);
  } finally { done(); }
});

test("completeCommand: add/remove complete their SECOND-argument target (re-based start)", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // the leading @name completes through the plain target slot
    assert.deepEqual(comp("add @").candidates, ["all", "second", "stored"]);
    assert.deepEqual(comp("add @st"), { start: 5, candidates: ["stored"], applied: "ored" });
    // the second argument is a TREE target — the expr core, re-based
    assert.deepEqual(comp("add @stored c"), { start: 12, candidates: ["c0", "c1"], applied: "" });
    assert.deepEqual(comp("add @stored c0"), { start: 12, candidates: ["g0"], applied: "." });
    assert.deepEqual(comp("remove @stored c0"), { start: 15, candidates: ["g0"], applied: "." });
    // a union in the second argument keeps completing
    assert.deepEqual(comp("add @stored c0 + c"), { start: 17, candidates: ["c0", "c1"], applied: "" });
    // a malformed lead (no @) is inert — the command shape is already broken
    assert.deepEqual(comp("add alpha c").candidates, []);
  } finally { done(); }
});

test("completeCommand: color-family value slot — named CSS colors (hex stays open input)", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    assert.deepEqual(comp("colorpoints c0 ste"),
      { start: 15, candidates: ["steelblue"], applied: "elblue", kind: "value" });
    assert.deepEqual(comp("colorbonds c0 re").candidates, ["rebeccapurple", "red"]);
    assert.deepEqual(comp("colorbondsof c0 ste"),
      { start: 16, candidates: ["steelblue"], applied: "elblue", kind: "value" });
    assert.deepEqual(comp("colortrace c0 gol"),
      { start: 14, candidates: ["gold", "goldenrod"], applied: "d", kind: "value" });
    // the FULL color table overflows the display cap — count-and-hint, the
    // same one rule path completion applies (pool unchanged, display capped)
    const all = comp("colorpoints c0 ");
    assert.match(all.candidates[0], /^\d+ matches$/);
    assert.equal(all.candidates[1], "— type to narrow");
    // a hex token is a no-op (open input, not enumerable)
    assert.deepEqual(comp("colorpoints c0 #ff").candidates, []);
  } finally { done(); }
});

test("completeCommand: the color slot's + union guard — 'be' completes as a TARGET term", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // the trailing chunk after "c0 +" is MORE TARGET, never a color
    assert.deepEqual(comp("colorpoints c0 + c"),
      { start: 17, candidates: ["c0", "c1"], applied: "" });
    assert.equal(comp("colorpoints c0 + c").kind, undefined);
    // with the union complete, the next word IS the color again
    assert.equal(comp("colorpoints c0 + c1 re").kind, "value");
  } finally { done(); }
});

test("completeCommand: style verbs complete registered style names after the target", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    assert.deepEqual(comp("stylepoints c0 "),
      { start: 15, candidates: ["matte", "standard"], applied: "", kind: "value" });
    assert.deepEqual(comp("stylebonds c0 ma"),
      { start: 14, candidates: ["matte"], applied: "tte", kind: "value" });
    assert.deepEqual(comp("styletrace c0 stan"),
      { start: 14, candidates: ["standard"], applied: "dard", kind: "value" });
    // the target still completes ahead of the style word
    assert.deepEqual(comp("stylepoints c").candidates, ["c0", "c1"]);
  } finally { done(); }
});

test("completeCommand: shape completes its domain word, then that domain's registered names", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    // domain slot: the verb's own table (points | bonds | traces)
    assert.deepEqual(comp("shape "),
      { start: 6, candidates: ["bonds", "points", "traces"], applied: "", kind: "value" });
    assert.deepEqual(comp("shape p"),
      { start: 6, candidates: ["points"], applied: "oints ", kind: "value" });
    // name slot: the registry's names FOR the typed domain
    assert.deepEqual(comp("shape points "),
      { start: 13, candidates: ["sphere"], applied: "sphere", kind: "value" });
    assert.deepEqual(comp("shape traces ri"),
      { start: 13, candidates: ["ribbon"], applied: "bbon", kind: "value" });
    // unknown domain / beyond the name: inert
    assert.deepEqual(comp("shape bogus ").candidates, []);
    assert.deepEqual(comp("shape points sphere ").candidates, []);
  } finally { done(); }
});

test("completeCommand: background completes a named color as its ONE argument", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    assert.deepEqual(comp("background nav"),
      { start: 11, candidates: ["navajowhite", "navy"], applied: "", kind: "value" });
    assert.deepEqual(comp("background navy").applied, "");
    assert.deepEqual(comp("background midnightb"),
      { start: 11, candidates: ["midnightblue"], applied: "lue", kind: "value" });
    // background takes exactly one argument — nothing completes after it
    assert.deepEqual(comp("background navy ").candidates, []);
  } finally { done(); }
});

test("completeCommand: rm completes workspace mod names + 'all' (built-ins never offered)", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    const bare = comp("rm ");
    assert.equal(bare.kind, "value");
    assert.ok(bare.candidates.includes("compmod"));
    assert.ok(bare.candidates.includes("all"));
    assert.ok(!bare.candidates.includes("zz_comp_builtin"),
      "built-ins are refused by rm — never offered");
    assert.deepEqual(comp("rm comp"),
      { start: 3, candidates: ["compmod"], applied: "mod", kind: "value" });
    // selector terms split on '+', spaces optional
    assert.deepEqual(comp("rm compmod+co"),
      { start: 11, candidates: ["compmod"], applied: "mpmod", kind: "value" });
    assert.deepEqual(comp("rm compmod + a"),
      { start: 13, candidates: ["all"], applied: "ll", kind: "value" });
  } finally { done(); }
});

test("completeCommand: help completes a registered verb name (mod verbs included)", () => {
  const { comp, done } = makeCompletionFixture();
  try {
    assert.deepEqual(comp("help colorp"),
      { start: 5, candidates: ["colorpoints"], applied: "oints", kind: "value" });
    assert.deepEqual(comp("help compm"),
      { start: 5, candidates: ["compmod"], applied: "od", kind: "value" });
    assert.ok(comp("help ").candidates.includes("view"));
    // one argument only
    assert.deepEqual(comp("help view ").candidates, []);
  } finally { done(); }
});
