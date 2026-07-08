/**
 * Spot-check: run a REAL corpus system's header through the exact classification
 * path the sidebar uses (real producer -> contract header -> bulkCategories /
 * buildTree), and report the tree shape. Test infrastructure, not product code.
 *
 * Run from viewer/ with an mdtraj-capable interpreter and the corpus root:
 *   VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \
 *   node tests/sidebar_spotcheck.ts --system 06_membrane_complex --python /path/to/mdbench/python
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseHeader } from "../contract/contract.ts";
import { ProducerBroker } from "../src/broker.ts";
import { bulkCategories, buildTree } from "../webview/classification.ts";
import { Hierarchy, NodeSet } from "../webview/sets.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: { system: { type: "string" }, python: { type: "string", default: "python3" } },
});
if (!args.system) {
  console.error("need --system <corpus id>");
  process.exit(2);
}

const broker = new ProducerBroker(
  { pythonPath: args.python, serveScript: join(root, "producer", "serve.py"), producerArgs: ["--system", args.system] },
  {
    onMessage: (payload) => {
      const header = parseHeader(new TextDecoder().decode(payload));
      const bulk = bulkCategories(header);
      const t0 = performance.now();
      const tree = buildTree(header);
      const buildMs = performance.now() - t0;

      let totalSub = 0;
      for (const c of tree.categories) totalSub += c.subgroupCount;
      console.log(`\n=== ${args.system} : N=${header.n_points}, groups=${Object.keys(header.groups).length}, subgroups(total)=${totalSub} ===`);
      console.log(`buildTree: ${buildMs.toFixed(1)}ms · top-level category rows shown by default: ${tree.categories.length}`);
      for (const c of tree.categories) {
        console.log(
          `  cat ${c.categoryIndex} ${JSON.stringify(c.label)}: ${c.pointCount} pts, ` +
            `${c.groupCount} groups, ${c.subgroupCount} subgroups${c.bulk ? "  <BULK: collapsed+hidden by default>" : ""}`,
        );
      }
      console.log(`bulk categories (hidden by default): ${[...bulk].join(", ") || "none"}`);

      // Exercise selection on the first non-bulk group with subgroups, if any.
      const hierarchy = new Hierarchy(header);
      const sel = new NodeSet(hierarchy);
      const target = tree.categories.find((c) => !c.bulk && c.groups.some((g) => g.subgroups.length > 0));
      if (target) {
        const g = target.groups.find((gg) => gg.subgroups.length > 0)!;
        const subId = g.subgroups[0].subgroupId;
        sel.add({ level: "subgroup", id: subId });
        console.log(`select subgroup ${subId} -> ${sel.pointCount} point indices, entries=${sel.entryCount}`);
      } else {
        console.log("no non-bulk structured subgroup to select (degenerate structure — OK)");
      }
      broker.dispose();
      process.exit(0);
    },
    onExit: (reason) => {
      console.error(`producer exit: ${reason}`);
      process.exit(1);
    },
    onLog: () => {},
  },
);
broker.start();
broker.send({ type: "header" });
setTimeout(() => {
  console.error("timed out waiting for header");
  broker.dispose();
  process.exit(1);
}, 120_000).unref();
