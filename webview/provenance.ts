/**
 * Readers for `Header.provenance` — the producer's own prose record of what it
 * DID to the data before serving it, turned into something the status line can
 * say without misreporting a number.
 *
 * Pure and string-only: no DOM, no Three.js, so every case unit-tests in Node.
 *
 * The rule these share, and it is the whole point: a producer-side transformation
 * that changes a number the viewer PRINTS has to travel with a disclosure, or the
 * printed number becomes a caption for something else. `T=500` on a 15 000-frame
 * trajectory is a lie about the frame axis; `173 940 edges` on a file that
 * declares 50 495 bonds is a lie about connectivity. Both facts are already in
 * `Header.provenance` — the model reads it through `get_context` — so the only
 * thing missing was the human.
 *
 * Robustness discipline (inherited from the frame-sampling reader and applied to
 * every reader here): `provenance` is an OPTIONAL, OPEN, producer-written list of
 * prose lines, so every shape it can arrive in — absent, null, not an array,
 * holding non-strings — lands on the quiet answer rather than throwing. Markers
 * are matched as a PREFIX only, never by position in the list and never by the
 * rest of the wording; and because a marker's PRESENCE is itself the fact, a line
 * whose numbers cannot be read still produces a note. Silence is the one outcome
 * that would misreport the data, so it is reachable only when the marker is
 * genuinely absent.
 */

/** What a status line needs in order to not misreport a number the producer
 * changed. `suffix` is appended DIRECTLY after that number so the qualifier can
 * never drift onto a different one; `detail` is the producer's own sentence(s),
 * verbatim, for a hover where length is free. */
export interface ProvenanceNote {
  /** Appended directly after the printed number. Always begins with a space;
   * never empty. */
  suffix: string;
  /** The producer's own sentence(s), verbatim. */
  detail: string;
}

/** Back-compat alias: the frame-sampling reader shipped with this name. */
export type FrameSamplingNote = ProvenanceNote;

/** Every provenance line starting with `prefix`, trimmed. Empty when there is
 * nothing to read — including when `provenance` is not a list at all. */
function linesWithPrefix(provenance: unknown, prefix: string): string[] {
  if (!Array.isArray(provenance)) return [];
  return provenance
    .filter((l): l is string => typeof l === "string")
    .map((l) => l.trim())
    .filter((l) => l.toLowerCase().startsWith(prefix));
}

/** The prefix the producer writes; see docs/COMMANDS.md ("a `frame sampling:
 *  stride N — …` line whenever the stride is not 1"). Matched as a prefix
 *  ONLY — never by position in the list, and never by the rest of the wording. */
const FRAME_SAMPLING_PREFIX = "frame sampling:";

/**
 * Read the frame-sampling disclosure out of `Header.provenance`, or null when
 * there is nothing to disclose (then the status line must stay byte-identical
 * to a viewer that never knew about striding — that is the whole contract of
 * returning null).
 *
 * The stride and the source count are read INDEPENDENTLY of each other, so a
 * reworded line still yields whichever facts it still states.
 */
export function frameSamplingNote(provenance: unknown): ProvenanceNote | null {
  const lines = linesWithPrefix(provenance, FRAME_SAMPLING_PREFIX);
  if (lines.length === 0) return null;
  const detail = lines.join("\n");
  // Both patterns tolerate one intervening word ("stride of 30", "500 frames
  // of 15000") so a reworded sentence still yields its numbers. Neither can
  // capture the stride's own "1 frame in 30": that phrase has no "of", and
  // "30 loaded, 500" fails the \s+ after the optional word (the comma).
  const stride = /\bstride\s+(?:\w+\s+)?(\d+)/i.exec(detail);
  const ofSource = /\b\d+\s+(?:\w+\s+)?of\s+(\d+)\b/i.exec(detail);
  let suffix = "";
  if (ofSource) suffix += ` of ${ofSource[1]}`;
  if (stride) suffix += ` (stride ${stride[1]})`;
  if (suffix === "") suffix = " (strided)"; // marker present, numbers unreadable
  return { suffix, detail };
}

/** The prefix `MdtrajSource._bond_inference_provenance` writes. Same matching
 *  discipline as the frame-sampling marker. */
const BOND_INFERENCE_PREFIX = "bond inference:";

/**
 * Read the covalent-bond-inference disclosure out of `Header.provenance`, or
 * null when the producer said nothing about it (then the status line stays
 * byte-identical to a viewer that never knew inference existed).
 *
 * WHY THIS EXISTS. The status line prints `header.edges.length`, and since
 * inference landed that count is no longer "the bonds in your file". On the
 * corpus membrane it is 173 940 edges of which 123 452 — 71% — were computed
 * from covalent radii and appear in no file the user opened. A user comparing
 * the viewer against another tool, or counting bonds, has to be able to see
 * that without asking. The producer already writes the sentence; this is the
 * half that shows it.
 *
 * Three outcomes, and each is a different fact:
 *   - no marker            -> null. Nothing was done, or an older producer.
 *   - the marker says OFF  -> ` (inference off)`. This is the one a user needs
 *                             most: they turned the fix DOWN, and the reason a
 *                             nucleic backbone or a ligand looks unbonded is a
 *                             SETTING, not the file. The producer emits this
 *                             line deliberately even though it inferred nothing.
 *   - a count is readable  -> ` (N inferred)`, appended to the edge count.
 * A marker whose number cannot be read still produces ` (some inferred)`,
 * because the presence of the line is itself the fact that edges were added.
 */
export function bondInferenceNote(provenance: unknown): ProvenanceNote | null {
  const lines = linesWithPrefix(provenance, BOND_INFERENCE_PREFIX);
  if (lines.length === 0) return null;
  const detail = lines.join("\n");
  // "off" is matched immediately after the marker, not anywhere in the line, so
  // a full-mode sentence that happens to contain the word cannot be mistaken
  // for a disabled one.
  if (new RegExp(`${BOND_INFERENCE_PREFIX}\\s*off\\b`, "i").test(detail)) {
    return { suffix: " (inference off)", detail };
  }
  // One intervening word tolerated ("123 bonds newly inferred"), matching the
  // frame-sampling reader's allowance for rewording.
  const count = /\b(\d+)\s+bonds?\s+(?:\w+\s+)?inferred/i.exec(detail);
  return { suffix: count ? ` (${count[1]} inferred)` : " (some inferred)", detail };
}
