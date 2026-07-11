/**
 * The typed-result BINDING layer — the pipe that turns a tool-result's
 * typed payload into a visible change in the viewer. Runs VIEWER-SIDE
 * (the terminal forwards `{type:"claude-bind", callId, result}` over the
 * relay; the outcome returns as `{type:"claude-bind-result"}` and renders
 * in the tool block). One closed-union dispatch, everything on existing
 * rails — nothing here re-implements resolution, writing, or execution:
 *
 *   per-point-scalar → resolveTargetPoints (view's exact header-ordered
 *                      resolution) + the per-element writer discipline
 *                      rainbow runs on (capture-prior + recordOp, ONE undo
 *                      stroke, LWW, own buffer, GPU sync via onWrite):
 *                      color through applyColorScalars + the built-in
 *                      colormap; size/opacity through the same factory's
 *                      per-element closures.
 *   command          → the exact runCommand a typed terminal command hits;
 *                      undo comes from the verb itself.
 *   per-frame-series → NOT HANDLED HERE: the host intercepts it before the
 *                      viewer relay and routes it to the plot panel
 *                      (plothost.ts); this dispatch keeps a defensive
 *                      branch only.
 *
 * Scalars arrive contractually normalized to [0,1]; this layer maps
 * [0,1] → visual and never normalizes, clamps-with-meaning, or interprets
 * magnitudes. A scalar-count/point-count mismatch writes NOTHING and
 * errors — no partial writes. An unknown kind is an error, not a guess.
 *
 * Pure module: no DOM, no Three — unit-tested against the stub ctx.
 */
import {
  applyColorScalars,
  resolveTargetPoints,
  type CommandContext,
  type CommandResult,
} from "./commands.ts";
import { parseTypedResult } from "./claudemodel.ts";
import { rainbow } from "./recipes.ts";

export interface BindOutcome {
  ok: boolean;
  message: string;
}

/** size axis: scalar 0..1 → point size 0..BIND_SIZE_MAX (2× the base size
 * 3 — a fixed visual range, NOT an interpretation of the values). The
 * opacity axis needs no mapping: [0,1] IS its full range. */
export const BIND_SIZE_MAX = 6;

export function bindTypedResult(
  ctx: CommandContext,
  runCommand: (text: string) => CommandResult,
  raw: unknown,
): BindOutcome {
  const result = parseTypedResult(raw);
  if (!result) {
    const kind = (raw as { kind?: unknown } | null | undefined)?.kind;
    return {
      ok: false,
      message: `unrecognized result payload${typeof kind === "string" ? ` (kind "${kind}")` : ""} — nothing applied`,
    };
  }
  switch (result.kind) {
    case "per-point-scalar": {
      const r = resolveTargetPoints(ctx, result.target);
      if ("status" in r) return { ok: false, message: r.message };
      if (result.scalars.length !== r.points.length) {
        return {
          ok: false,
          message: `scalar count mismatch: ${result.scalars.length} values for ${r.points.length} points of "${result.target}" — nothing written`,
        };
      }
      if (result.axis === "color") {
        const n = applyColorScalars(ctx, r.points, result.scalars, rainbow.colormap);
        return { ok: true, message: `colored ${n} points of "${result.target}" from scalars` };
      }
      if (result.axis === "size") {
        const n = ctx.sizePointsEach(r.points, result.scalars.map((t) => t * BIND_SIZE_MAX));
        return { ok: true, message: `sized ${n} points of "${result.target}" from scalars (0..${BIND_SIZE_MAX})` };
      }
      const n = ctx.opacityPointsEach(r.points, result.scalars);
      return { ok: true, message: `faded ${n} points of "${result.target}" from scalars` };
    }
    case "command": {
      const r = runCommand(result.command);
      return { ok: r.status === "ok", message: `${result.command} → ${r.message}` };
    }
    case "per-frame-series":
      // The plot panel's kind: the HOST intercepts it before the viewer
      // relay (plothost.ts) and answers the outcome itself — this branch is
      // defensive only (a series should never reach the viewer's binding).
      return {
        ok: false,
        message: `per-frame-series is routed to the plot panel — not a viewer binding`,
      };
  }
}
