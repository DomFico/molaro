/**
 * The terminal's single pending-confirmation slot — the FIRST command
 * machinery that waits for a second input. General by design (a slot
 * holding prompt text + an answer callback, usable by any future verb) but
 * deliberately NOT a prompt system: ONE slot, no nesting, no queueing. A
 * newer arm() replaces the old (the replaced prompt is dead — its callback
 * is never invoked).
 *
 * FAIL-SAFE answer parsing: while armed, EVERY input is consumed as the
 * answer, never executed as a command. `y`/`yes` (case-insensitive) is the
 * only affirmative; `n`/`no` and ANYTHING ELSE cancel — an ambiguous
 * answer never deletes, and never silently runs something the user meant
 * as an answer. The slot is single-shot (cleared BEFORE the callback runs)
 * and discarded on clear/reset (cancel semantics: the callback is NOT
 * invoked — nothing acts).
 *
 * Pure module: no DOM — unit-tested under `node --test`.
 */

export interface PromptGate {
  /** Arm the slot. Replaces any existing pending prompt (which is dead). */
  arm(prompt: string, onAnswer: (yes: boolean) => void): void;
  /** The pending prompt's text, or null when idle. */
  pending(): string | null;
  /** Offer an input line. Returns true if it was CONSUMED as the answer
   * (the caller must not execute it as a command); false when idle. */
  offer(input: string): boolean;
  /** Drop the pending prompt without answering (clear/reset paths). */
  discard(): void;
}

export function createPromptGate(): PromptGate {
  let slot: { prompt: string; onAnswer: (yes: boolean) => void } | null = null;
  return {
    arm(prompt, onAnswer): void {
      slot = { prompt, onAnswer };
    },
    pending(): string | null {
      return slot?.prompt ?? null;
    },
    offer(input: string): boolean {
      if (!slot) return false;
      const { onAnswer } = slot;
      slot = null; // single-shot, cleared before the callback runs
      onAnswer(/^y(es)?$/i.test(input.trim()));
      return true;
    },
    discard(): void {
      slot = null;
    },
  };
}
