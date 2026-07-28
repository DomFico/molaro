/**
 * The mods that COME STANDARD with the package (`<extension>/mods/*.py`).
 *
 * These ship inside the VSIX and are loaded with origin "built-in" alongside the
 * user's own (`src/extension.ts` `loadAllMods`). That makes them a PRODUCT
 * SURFACE, not user data, so they need a build-time gate for the two things the
 * runtime cannot recover from:
 *
 *   1. A shipped mod that does not PARSE is dead weight in every install — the
 *      loader skips it with a log line nobody reads, and the feature is simply
 *      missing. A workspace mod failing this way is the user's own file and
 *      their problem; a shipped one is ours.
 *   2. A shipped CONSUMER whose provider is not also shipped is worse than
 *      missing: `cartoon` would install, appear in the registry, and then fail
 *      at invocation on a machine where the user never had `ribbon_dir`. The
 *      set has to be CLOSED under `requires-channel`.
 *
 * The roster is asserted EXACTLY, not as a subset, so adding or dropping a
 * shipped mod is a deliberate edit here rather than a silent packaging change.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { channelConsumers, machineryNote, parseModFile } from "../webview/recipes.ts";

const MODS_DIR = join(import.meta.dirname, "..", "mods");

/** The exact shipped roster. Adding one is an edit HERE first. */
const EXPECTED = [
  "cartoon",
  "hide_res",
  "licorice",
  "live_sasa",
  "live_ss",
  "ribbon_dir",
  "sasa_field",
  "show_res",
  "ss_field",
] as const;

function shippedFiles(): string[] {
  return readdirSync(MODS_DIR).filter((f) => f.endsWith(".py")).sort();
}

function parseAll() {
  return shippedFiles().map((file) => {
    const parsed = parseModFile(readFileSync(join(MODS_DIR, file), "utf-8"), "built-in");
    assert.ok(parsed.ok, `shipped mod ${file} does not parse: ${parsed.ok ? "" : parsed.error}`);
    return { file, mod: parsed.mod };
  });
}

test("every shipped mod parses, and carries origin built-in", () => {
  const all = parseAll();
  assert.equal(all.length, EXPECTED.length, `shipped mod file count`);
  for (const { file, mod } of all) {
    // Origin is ASSIGNED by the loader, never read from the file — a mod file
    // cannot promote itself to built-in by writing a header line.
    assert.equal(mod.origin, "built-in", `${file} origin`);
    assert.equal(mod.kind, "analysis", `${file} kind`);
  }
});

test("the shipped roster is exactly the declared set", () => {
  const names = parseAll().map(({ mod }) => mod.name).sort();
  assert.deepEqual(names, [...EXPECTED].sort());
});

test("a shipped mod's file name matches its declared name", () => {
  // The loader keys on the HEADER name, not the filename, so a mismatch is not
  // fatal at run time — but it makes `rm`/`delete_mod` diagnostics and the mods
  // listing point at a file that does not exist under that name.
  for (const { file, mod } of parseAll()) {
    assert.equal(`${mod.name}.py`, file, `${file} declares name "${mod.name}"`);
  }
});

test("the shipped set is CLOSED under requires-channel", () => {
  const all = parseAll().map(({ mod }) => mod);
  const supplied = new Map<string, string>();
  for (const m of all) if (m.channel) supplied.set(m.channel, m.name);

  const consumers = all.filter((m) => m.requiresChannel);
  // Guards the guard: if the roster ever loses every consumer this test would
  // pass vacuously, which would hide exactly the regression it exists for.
  assert.ok(consumers.length >= 3, `expected shipped consumers, got ${consumers.length}`);

  for (const m of consumers) {
    const provider = supplied.get(m.requiresChannel!);
    assert.ok(
      provider,
      `shipped mod "${m.name}" requires channel "${m.requiresChannel}" but NO shipped mod ` +
        `supplies it — it would install and then fail at invocation. Ship the provider too.`,
    );
  }
});

test("every shipped channel provider declares the channel it is named for", () => {
  // These three exist ONLY as machinery for a consumer, and the consumer names
  // them by CHANNEL. A provider whose channel drifts from its name silently
  // orphans its consumer, which the closure test above would then catch — this
  // one says WHICH file moved.
  for (const { mod } of parseAll()) {
    if (mod.produces !== "channel") continue;
    assert.equal(mod.channel, mod.name, `${mod.name} declares channel "${mod.channel}"`);
  }
});

test("a malformed shipped file would be REJECTED, not silently accepted", () => {
  // The negative control: the parse assertions above are only meaningful if
  // parseModFile can actually fail on this input shape.
  const good = readFileSync(join(MODS_DIR, "ribbon_dir.py"), "utf-8");
  const broken = good.replace("# produces: channel", "# produces: nonsense");
  const parsed = parseModFile(broken, "built-in");
  assert.equal(parsed.ok, false, "a bad `produces` must fail the parse");
});

test("the mods listing hides machinery, names how many, and keeps the rest", () => {
  // The listing is what the owner reads, so it is what this asserts — via the same
  // channelConsumers/machineryNote pair the handler uses, over the real shipped set.
  const all = parseAll().map(({ mod }) => mod);
  const consumers = channelConsumers(all);
  const machinery = all.filter((m) => machineryNote(m.channel, consumers) !== "");
  const shown = all.filter((m) => machineryNote(m.channel, consumers) === "");

  assert.deepEqual(
    machinery.map((m) => m.name).sort(),
    ["ribbon_dir", "sasa_field", "ss_field"],
    "the three channel providers are the machinery",
  );
  assert.deepEqual(
    shown.map((m) => m.name).sort(),
    ["cartoon", "hide_res", "licorice", "live_sasa", "live_ss", "show_res"],
    "what remains listed is exactly the mods a person invokes",
  );

  // Guards the guard: if `requires-channel` were ever dropped from the consumers,
  // NOTHING would be classed as machinery and this would pass by listing all six.
  assert.equal(machinery.length, 3, "machinery must be detected, not vacuously empty");
});

test("a channel mod NOBODY requires is NOT hidden", () => {
  // The rule is derived from who-requires-what, not from `produces === "channel"`.
  // A standalone channel mod is still yours to type, so it must keep listing.
  const all = parseAll().map(({ mod }) => mod);
  const orphan = { name: "lonely_field", channel: "lonely_field" } as { name: string; channel?: string; requiresChannel?: string };
  const consumers = channelConsumers([...all, orphan]);
  assert.equal(machineryNote(orphan.channel, consumers), "",
    "a channel nobody requires earns no machinery note, so it stays listed");
  assert.notEqual(machineryNote("sasa_field", consumers), "",
    "(control) a channel that IS required still earns one");
});
