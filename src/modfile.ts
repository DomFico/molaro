/**
 * Writing a mod to disk — the one place `.molaro/mods/<name>.py` is created or
 * replaced, extracted from extension.ts so it can be tested. (Same reason
 * hostmessages.ts and webviewcsp.ts exist: extension.ts imports `vscode` and
 * therefore cannot run under `node --test`.)
 *
 * THE DEFECT THIS CLOSES. The write was an unconditional `writeFileSync`, so
 * `write_mod` was a silent data-loss path: a name collision destroyed whatever
 * was at that path, and the approval the human gave displayed the NEW mod's
 * Python — never the fact that something was being replaced. On this surface's
 * own terms that was inconsistent: DELETING `.molaro/mods/x.py` requires the
 * gated, y/n-confirmed `delete_mod`, while overwriting the identical file
 * required nothing at all.
 *
 * WHY PRESERVE RATHER THAN REFUSE. Refusing a collision outright would break the
 * legitimate case — an author fixing their own mod, which the cold acceptance
 * runs do routinely — and would push the model toward inventing name variants to
 * get around it. Keeping the previous bytes costs nothing and loses nothing, and
 * the replacement is REPORTED so the human learns of it in the same line that
 * reports the write.
 *
 * THE BACKUP NAME IS LOAD-BEARING. It ends in `.bak`, not `.py`, because
 * loadWorkspaceMods filters on `.py` — so a backup can never register as a mod,
 * shadow one, appear in `mods`, or be enumerated by `rm all`. It is inert bytes
 * sitting beside the file it came from.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ModWriteResult {
  /** Absolute path written. */
  file: string;
  /** Absolute path the PREVIOUS contents were preserved at, or null if this
   * was a fresh create. Non-null means something was replaced. */
  backup: string | null;
}

/**
 * Write `source` to `<dir>/<name>.py`, preserving any prior file first.
 *
 * `now` is injected so the backup name is deterministic under test; production
 * callers use the default.
 */
export function saveModFile(
  dir: string,
  name: string,
  source: string,
  now: () => number = Date.now,
): ModWriteResult {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.py`);
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.${now()}.bak`;
    copyFileSync(file, backup); // preserve BEFORE the write, never after
  }
  writeFileSync(file, source, "utf-8");
  return { file, backup };
}

/** The sentence write_mod appends when a save displaced something. Kept here so
 * the wording and the behaviour cannot drift apart. */
export function replacementNote(backup: string | null): string {
  return backup
    ? ` (REPLACED an existing mod of that name; the previous file was kept at ${backup})`
    : "";
}
