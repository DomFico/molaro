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
