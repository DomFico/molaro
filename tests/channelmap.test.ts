/**
 * Unit tests for the channel→axis gate and mapping (webview/channelmap.ts) —
 * THE shared choke point for the bake verb today and the live bind verb next.
 * Every refusal names its reason; nothing about these cases may loosen when
 * Tier 2 arrives. Pure, no DOM. Run from viewer/:
 *   node --test tests/channelmap.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BIND_AXES,
  BIND_SIZE_MAX,
  gateChannelBind,
  normalizeScalars,
  type ChannelDecl,
} from "../webview/channelmap.ts";

const scalar = (over: Partial<ChannelDecl> = {}): ChannelDecl => ({
  name: "energy",
  scope: "per_point_per_frame",
  components: 1,
  ...over,
});
const VALUES = [0, 1.25, 2.5];

test("gate: the axis list is the three scalar point axes", () => {
  assert.deepEqual([...BIND_AXES], ["color", "size", "opacity"]);
  assert.equal(BIND_SIZE_MAX, 6);
});

test("gate: orientation ACCEPTS a 3-wide channel raw — range null, no normalization", () => {
  const r = gateChannelBind(scalar({ components: 3 }), "orientation", null, [1, 0, 0]);
  assert.deepEqual(r, { range: null });
});

test("gate: scalar→orientation refuses by width; a range on orientation is a category error", () => {
  const narrow = gateChannelBind(scalar(), "orientation", null, VALUES);
  assert.ok("error" in narrow && narrow.error.includes("orientation needs a vector (3-wide) channel"), JSON.stringify(narrow));
  const ranged = gateChannelBind(scalar({ components: 3 }), "orientation", [0, 1], [1, 0, 0]);
  assert.ok("error" in ranged && ranged.error.includes("meaningless for the orientation axis"), JSON.stringify(ranged));
  // the finiteness spot-check runs on the vector path too, element = i / 3
  const bad = gateChannelBind(scalar({ components: 3 }), "orientation", null, [1, 0, 0, 0, NaN, 0]);
  assert.ok("error" in bad && bad.error.includes("non-finite value at element 1"), JSON.stringify(bad));
});

test("gate: unknown axis is refused by name", () => {
  const r = gateChannelBind(scalar({ min: 0, max: 1 }), "colr", null, VALUES);
  assert.ok("error" in r && r.error.includes('unknown axis "colr"'));
});

test("gate: a per-frame channel is a series, not per-element — refused", () => {
  const r = gateChannelBind(scalar({ scope: "per_frame", min: 0, max: 9 }), "color", null, VALUES);
  assert.ok("error" in r && r.error.includes("per-frame"));
});

test("gate: a vector channel cannot drive a scalar axis — refused with its width", () => {
  const r = gateChannelBind(scalar({ components: 3 }), "color", null, [1, 0, 0]);
  assert.ok("error" in r && r.error.includes("components: 3"));
});

test("gate: no full range anywhere → refused, pointing at the explicit form", () => {
  for (const decl of [scalar(), scalar({ min: 0 }), scalar({ max: 5 })]) {
    const r = gateChannelBind(decl, "color", null, VALUES);
    assert.ok("error" in r && r.error.includes("explicitly"), JSON.stringify(decl));
  }
});

test("gate: a declared full range passes; an explicit range OVERRIDES it", () => {
  const declared = gateChannelBind(scalar({ min: 0, max: 2.5 }), "size", null, VALUES);
  assert.deepEqual(declared, { range: [0, 2.5] });
  const explicit = gateChannelBind(scalar({ min: 0, max: 2.5 }), "size", [1, 2], VALUES);
  assert.deepEqual(explicit, { range: [1, 2] });
});

test("gate: an empty or inverted range is refused (min must be < max)", () => {
  for (const range of [[2, 2], [3, 1]] as [number, number][]) {
    const r = gateChannelBind(scalar(), "opacity", range, VALUES);
    assert.ok("error" in r && r.error.includes("min must be strictly less than max"), String(range));
  }
});

test("gate: no values in hand → refused (fail closed, never a guess)", () => {
  const r = gateChannelBind(scalar({ min: 0, max: 1 }), "color", null, null);
  assert.ok("error" in r && r.error.includes("no values in hand"));
});

test("gate: the finiteness spot-check names the offending ELEMENT", () => {
  const r = gateChannelBind(scalar({ min: 0, max: 1 }), "color", null, [0, NaN, 1]);
  assert.ok("error" in r && r.error.includes("non-finite value at element 1"));
  const inf = gateChannelBind(scalar({ min: 0, max: 1 }), "color", null, [0, 1, Infinity]);
  assert.ok("error" in inf && inf.error.includes("element 2"));
});

test("normalize: linear over the range, selecting and ORDERING by the point list", () => {
  assert.deepEqual(normalizeScalars(VALUES, [0, 1, 2], [0, 2.5]), [0, 0.5, 1]);
  // subset + order: the output follows the resolved points, not element order
  assert.deepEqual(normalizeScalars(VALUES, [2, 0], [0, 2.5]), [1, 0]);
});

test("normalize: out-of-range values SATURATE at 0 and 1 (a lens, not a bound)", () => {
  assert.deepEqual(normalizeScalars([-5, 0.5, 99], [0, 1, 2], [0, 1]), [0, 0.5, 1]);
});
