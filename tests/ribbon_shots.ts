/**
 * Item B evidence — two ribbon screenshots (moderate bend + sharp twist) with
 * the bend miter live, zoomed onto the junctions so the closed wedge is visible.
 * Run from viewer/ (after npm run build):  node tests/ribbon_shots.ts
 * Writes reports/redesign/ribbon_miter_bend.png + ribbon_miter_twist.png.
 */
import { E2EDriver } from "./e2e_driver.ts";

const V = "window.__viewer";

async function main(): Promise<void> {
  const d = new E2EDriver({
    bridgePort: 41000, cdpPort: 41300, width: 1180, height: 780,
    producerArgs: ["--n-points", "6000", "--n-frames", "150"],
  });
  try {
    await d.start();
    await d.navigate("/");
    await d.waitFor(`window.__viewer && window.__viewer.player.stats().cachedChunks > 0`, 20000);
    await d.evaluate(`(async () => { for (let i=0;i<2;i++) await new Promise(r=>requestAnimationFrame(r)); })()`);

    const cmd = (t: string) => d.evaluate(`${V}.command(${JSON.stringify(t)})`);
    const rafs = () => d.evaluate(`(async () => { for (let i=0;i<4;i++) await new Promise(r=>requestAnimationFrame(r)); })()`);
    const seek = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
      await rafs();
    };

    await d.evaluate(`${V}.setPlaying && ${V}.setPlaying(false)`);
    await cmd("shape traces ribbon");
    await cmd("bind all flow orientation");
    // ISOLATE the ribbon: zero the point spheres + edge tubes so only the band
    // shows, fatten the band, and frame the polyline's own points.
    await cmd("size all 0");
    await cmd("bondsize all 0");
    await cmd("tracesize all 8");
    await d.evaluate(`${V}.zoomToPoints(${V}.traceVertices)`);
    await rafs();

    await seek(0);
    await d.screenshot("reports/redesign/ribbon_miter_bend.png");
    console.log("wrote reports/redesign/ribbon_miter_bend.png (frame 0, moderate bend)");

    await seek(40);
    await d.screenshot("reports/redesign/ribbon_miter_twist.png");
    console.log("wrote reports/redesign/ribbon_miter_twist.png (frame 40, sharp twist)");
  } finally {
    await d.dispose();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
