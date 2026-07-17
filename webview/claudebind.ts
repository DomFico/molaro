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
import { BIND_SIZE_MAX } from "./channelmap.ts";
import {
  applyScalarsToAxis,
  resolveTargetPoints,
  type CommandContext,
  type CommandResult,
} from "./commands.ts";
import { parseTypedResult } from "./claudemodel.ts";

export interface BindOutcome {
  ok: boolean;
  message: string;
}

/** Re-exported from channelmap.ts (the scalar→axis mapping's single source —
 * shared with the bake verb so the two visual ranges cannot diverge). */
export { BIND_SIZE_MAX };

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
      const n = applyScalarsToAxis(ctx, result.axis, r.points, result.scalars);
      if (result.axis === "color") {
        return { ok: true, message: `colored ${n} points of "${result.target}" from scalars` };
      }
      if (result.axis === "size") {
        return { ok: true, message: `sized ${n} points of "${result.target}" from scalars (0..${BIND_SIZE_MAX})` };
      }
      return { ok: true, message: `faded ${n} points of "${result.target}" from scalars` };
    }
    case "command": {
      const r = runCommand(result.command);
      return { ok: r.status === "ok", message: `${result.command} → ${r.message}` };
    }
    case "per-frame-series":
    case "scatter":
      // The plot panel's kinds: the HOST intercepts them before the viewer
      // relay (plothost.ts) and answers the outcome itself — this branch is
      // defensive only (they should never reach the viewer's binding).
      return {
        ok: false,
        message: `${result.kind} is routed to the plot panel — not a viewer binding`,
      };
  }
}
