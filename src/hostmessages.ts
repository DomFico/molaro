/**
 * Host relay routing — which terminal→host messages the host forwards to the
 * VIEWER. The terminal and viewer are SEPARATE webviews, so the host is the
 * only path between them. PURE (no vscode) so it is unit-tested.
 *
 * `confirm-answer` (rm's y/n) MUST be in this set: its omission dropped the
 * confirmed delete on the floor and made `rm` fail SILENTLY in real VS Code
 * (the in-page test harness masked it by looping the answer back itself).
 */
export const TERMINAL_MESSAGES_TO_VIEWER = [
  "confirm-answer",
  "command",
  "complete",
  "claude-bind",
] as const;

export function relaysTerminalMessageToViewer(type: string | undefined): boolean {
  return (TERMINAL_MESSAGES_TO_VIEWER as readonly string[]).includes(type ?? "");
}

/**
 * Marker the producer prints on stderr (via `log.info`) to announce a coarse
 * loading step BEFORE it blocks parsing a dataset. A large topology (e.g. the
 * 222k-atom membrane complex) takes several seconds and ~0.5 GB to load, all of
 * it inside `build_source` before the first `header` request is even read — so
 * the host has no protocol message to relay in that window. This is the one
 * signal it does get: a stderr line the broker already forwards to `onLog`. The
 * host recognizes it and surfaces the text to the viewer's loading overlay so a
 * slow load reads as "working", not frozen.
 *
 * SINGLE SOURCE of this string is producer/serve.py (the emitter). Keep the two
 * in lockstep — hostmessages.test.ts pins the parse; a producer-load run proves
 * the emit. Emitting an unsolicited PROTOCOL frame instead is not an option: the
 * transport is strict FIFO one-reply-per-request (webview/transport.ts), so an
 * out-of-band frame would break response correlation.
 */
export const PRODUCER_STATUS_MARKER = "PRODUCER-STATUS:";

/**
 * If `line` (a producer stderr log line) carries the loading marker, return the
 * human status text after it (trimmed); otherwise null. Pure — the caller posts
 * it to the viewer. Tolerant of the logging prefix ("producer INFO …") because
 * it splits on the marker rather than anchoring at the start.
 */
export function producerStatusFromLog(line: string): string | null {
  const at = line.indexOf(PRODUCER_STATUS_MARKER);
  if (at < 0) return null;
  const text = line.slice(at + PRODUCER_STATUS_MARKER.length).trim();
  return text.length > 0 ? text : null;
}

/** Synthetic-source defaults when `viewer.open` is given no size. */
export const DEFAULT_N_POINTS = 20_000;
export const DEFAULT_N_FRAMES = 600;

/**
 * What a caller can ask `viewer.open` / `viewer.openFile` for. Exactly one of
 * `openPath` (open this file directly), `system` (a benchmark corpus id) or
 * `topology` (+ optional `trajectory`) selects a real dataset; with none of them
 * the synthetic source is used.
 */
export interface ProducerOpenSpec {
  openPath?: string;
  system?: string;
  topology?: string;
  trajectory?: string;
  ligandResidues?: readonly string[];
  nPoints?: number;
  nFrames?: number;
  seed?: number;
  /**
   * Override for the producer's display FRAME CAP — how many trajectory frames a
   * real dataset loads. Positive caps at that many (a longer trajectory loads
   * with a stride and says so in `Header.provenance`); NEGATIVE loads every frame
   * (no cap); `undefined` or 0 sends nothing, leaving the producer's own default
   * (`DEFAULT_MAX_FRAMES` in producer/source.py — the ONE place that number
   * lives, which is why 0 is a "say nothing" sentinel here rather than a second
   * copy of it). 0 is never forwarded, so it can't collide with the CLI's meaning
   * of 0 (= no cap).
   */
  maxFrames?: number;
  /**
   * Override for the producer's COVALENT-BOND INFERENCE mode — see
   * `molaro.viewer.inferBonds`. `"full"` infers every bond a topology does not
   * declare, `"nonsolvent"` skips solvent residues, `"off"` draws only declared
   * bonds. `undefined` (and the empty string a cleared setting produces) sends
   * nothing, leaving the producer's own default as the ONE place that choice
   * lives (`DEFAULT_MODE` in producer/bond_inference.py) — the same "say nothing"
   * discipline `maxFrames` uses with 0.
   */
  inferBonds?: string;
}

/**
 * The producer argv (and panel title) for an open request. ONE function for every
 * entry point — `viewer.open` with a corpus id / an explicit topology / nothing,
 * and `viewer.openFile` from the Explorer — so an argument that must reach the
 * producer (the frame cap and the bond-inference mode are the current ones)
 * cannot be threaded onto some commands and forgotten on others. Pure (no
 * vscode), so it is unit-tested; the caller reads settings and passes the
 * resolved values in.
 */
export function producerOpenArgs(spec: ProducerOpenSpec): { producerArgs: string[]; title: string } {
  // Flags that apply to REAL datasets only, in one place so all three real-dataset
  // branches below carry exactly the same set. --n-frames is an explicit request
  // for a synthetic size, not a file whose length is an accident of how long a
  // simulation ran, so the frame cap has nothing to say about it; and the
  // synthetic source has no topology, so bond inference has nothing to infer.
  const cap = spec.maxFrames !== undefined && spec.maxFrames !== 0
    ? ["--max-frames", String(spec.maxFrames)]
    : [];
  const bonds = spec.inferBonds ? ["--infer-bonds", spec.inferBonds] : [];
  const real = [...cap, ...bonds];
  if (spec.openPath) {
    return {
      producerArgs: ["--open", spec.openPath, ...real],
      title: `Point Viewer (${basename(spec.openPath)})`,
    };
  }
  if (spec.system) {
    return {
      producerArgs: ["--system", spec.system, ...real],
      title: `Point Viewer (${spec.system})`,
    };
  }
  if (spec.topology) {
    const args = ["--dataset", spec.topology];
    if (spec.trajectory) args.push("--trajectory", spec.trajectory);
    for (const lig of spec.ligandResidues ?? []) args.push("--ligand-residue", lig);
    return {
      producerArgs: [...args, ...real],
      title: `Point Viewer (${basename(spec.topology)})`,
    };
  }
  const nPoints = spec.nPoints ?? DEFAULT_N_POINTS;
  const nFrames = spec.nFrames ?? DEFAULT_N_FRAMES;
  const seed = spec.seed ?? 7;
  return {
    producerArgs: [
      "--n-points", String(nPoints), "--n-frames", String(nFrames), "--seed", String(seed),
    ],
    title: `Point Viewer (N=${nPoints})`,
  };
}

/** Last path segment, for a panel title. Tolerates either separator and a
 * trailing one, and falls back to the whole string. */
function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/**
 * Resolve which file a deletion of mod `name` would remove, using ONLY the
 * scanned mod path-map — NEVER a path derived from `name`. This is rm's
 * path-map discipline, shared so `delete_mod` (the gated tool) cannot drift from
 * it: built-ins (code, never scanned), unknown names, and path-traversal strings
 * are simply absent from the map, so they resolve to a refusal and nothing
 * outside `.molaro/mods` can ever be touched. Pure — the caller does the unlink.
 */
export function resolveModDeletion(
  modPaths: ReadonlyMap<string, string>,
  name: string,
): { file: string } | { refused: string } {
  const file = modPaths.get(name);
  if (file === undefined) {
    return {
      refused:
        `"${name}" is not a workspace mod under .molaro/mods — nothing deleted ` +
        `(built-ins can't be deleted; delete_mod only removes scanned mod files).`,
    };
  }
  return { file };
}
