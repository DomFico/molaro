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
