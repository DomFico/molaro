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
