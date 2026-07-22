/**
 * Writing a mod must never destroy one — the guard for a silent data-loss path.
 *
 * `write_mod` is gated, but its approval preview shows the NEW mod's Python and
 * says nothing about replacement, so a human approving a write could not tell it
 * was about to lose a file. Deleting the same file requires the gated,
 * y/n-confirmed `delete_mod`. These tests pin the resolution: the prior bytes are
 * preserved, the caller is told, and the preserved copy can never be mistaken for
 * a mod.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replacementNote, saveModFile } from "../src/modfile.ts";

const workspace = () => mkdtempSync(join(tmpdir(), "molaro-modfile-"));

test("a fresh create writes the file and reports no replacement", () => {
  const dir = workspace();
  const r = saveModFile(dir, "alpha", "# molaro-mod\nprint(1)\n");
  assert.equal(r.backup, null);
  assert.equal(r.file, join(dir, "alpha.py"));
  assert.equal(readFileSync(r.file, "utf-8"), "# molaro-mod\nprint(1)\n");
  assert.equal(replacementNote(r.backup), "", "nothing displaced → nothing to say");
});

test("overwriting PRESERVES the previous file instead of destroying it", () => {
  const dir = workspace();
  saveModFile(dir, "alpha", "ORIGINAL — the user's own work\n");
  const r = saveModFile(dir, "alpha", "REPLACEMENT\n", () => 1700000000000);

  assert.notEqual(r.backup, null, "a collision must be preserved, not clobbered");
  assert.equal(readFileSync(r.file, "utf-8"), "REPLACEMENT\n", "the new mod is what registers");
  assert.equal(readFileSync(r.backup!, "utf-8"), "ORIGINAL — the user's own work\n",
    "THE POINT: the displaced bytes still exist and are recoverable");
});

test("the caller is TOLD, so the replacement reaches the human who approved the write", () => {
  const dir = workspace();
  saveModFile(dir, "alpha", "first\n");
  const r = saveModFile(dir, "alpha", "second\n", () => 42);
  const note = replacementNote(r.backup);
  assert.match(note, /REPLACED an existing mod/);
  assert.match(note, /alpha\.py\.42\.bak/, "it names where the previous file went");
});

test("a backup can never be loaded as a mod — it does not end in .py", () => {
  const dir = workspace();
  saveModFile(dir, "alpha", "first\n");
  saveModFile(dir, "alpha", "second\n", () => 7);
  // loadWorkspaceMods filters on `.py`; anything else is invisible to it, so a
  // backup cannot register, shadow a real mod, appear in `mods`, or be swept by
  // `rm all`.
  const loadable = readdirSync(dir).filter((f) => f.endsWith(".py"));
  assert.deepEqual(loadable, ["alpha.py"],
    "exactly one loadable mod after a replacement — the backup must not be one of them");
  assert.equal(readdirSync(dir).length, 2, "…and the backup is nonetheless still on disk");
});

test("repeated replacement keeps every generation, never overwriting a backup", () => {
  const dir = workspace();
  saveModFile(dir, "alpha", "v1\n");
  saveModFile(dir, "alpha", "v2\n", () => 1);
  saveModFile(dir, "alpha", "v3\n", () => 2);
  const backups = readdirSync(dir).filter((f) => f.endsWith(".bak")).sort();
  assert.deepEqual(backups, ["alpha.py.1.bak", "alpha.py.2.bak"]);
  assert.equal(readFileSync(join(dir, "alpha.py.1.bak"), "utf-8"), "v1\n");
  assert.equal(readFileSync(join(dir, "alpha.py.2.bak"), "utf-8"), "v2\n");
});

test("a name that collides with an unrelated existing file is still preserved", () => {
  // The path is derived from the mod name, so a file that was never written by
  // this code can still be the thing displaced.
  const dir = workspace();
  writeFileSync(join(dir, "handwritten.py"), "# written by hand, not by write_mod\n", "utf-8");
  const r = saveModFile(dir, "handwritten", "# generated\n", () => 9);
  assert.equal(readFileSync(r.backup!, "utf-8"), "# written by hand, not by write_mod\n");
});
