import { expect, test } from "./lab";

test.describe("simulated detector", () => {
  test("parked over the pipeline every box is drawn, only anomaly candidates and unknowns are labelled", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(3);
    await lab.waitFor((s) => s.detections.length >= 2);
    const dets = await lab.state((s) => s.detections);
    const feed = page.locator("#gantry-camera-feed");
    const fb = (await feed.boundingBox())!;
    const labelled = (cls: string) => feed.getByText(new RegExp(`^SIM ${cls} `));
    for (const d of dets) {
      expect(d.confidence).toBeGreaterThanOrEqual(0.6 - 0.05);
      expect(d.bbox.every((v) => v >= 0 && v <= 1)).toBe(true);
      if (d.class === "LOOSE_CABLE" || d.class === "FOREIGN_OBJECT" || d.class === "UNKNOWN") {
        const label = labelled(d.class).first();
        await expect(label).toBeVisible();
        const lb = (await label.boundingBox())!;
        expect(lb.x).toBeGreaterThanOrEqual(fb.x - 1);
        expect(lb.x + lb.width).toBeLessThanOrEqual(fb.x + fb.width + 1);
      } else {
        await expect(labelled(d.class)).toHaveCount(0);
      }
    }
    // the detection state is the corner style (solid or dim), never a text tag
    await expect(feed.getByText(/^(LOCKED|DETECTED|SCAN)$/)).toHaveCount(0);
  });

  test("two labels that would overlap: only the more confident one is drawn, both boxes stay", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(3);
    // park the wrench on the crate: both are foreign objects in the same spot, so their labels cannot both fit
    await page.evaluate(() => {
      const s = window.__labStore!.getState();
      s.moveObject("wrench-1", 25, 33);
      s.moveGantryTo(25, 32);
    });
    await lab.fastForward(15);
    await lab.waitFor((s) => ["crate-1", "wrench-1"].every((id) => s.detections.some((d) => d.objectId === id)));
    const [crate, wrench] = await lab.state((s) => ["crate-1", "wrench-1"].map((id) => s.detections.find((d) => d.objectId === id)!));
    const text = (d: typeof crate) => `SIM ${d.class} ${(d.confidence * 100).toFixed(1)}%`;
    expect(text(crate)).not.toBe(text(wrench));
    const [best, worst] = crate.confidence > wrench.confidence ? [crate, wrench] : [wrench, crate];
    const feed = page.locator("#gantry-camera-feed");
    await expect(feed.getByText(text(best), { exact: true })).toHaveCount(1);
    await expect(feed.getByText(text(worst), { exact: true })).toHaveCount(0);
    // both boxes keep their four corner marks
    const all = await lab.state((s) => s.detections.length);
    await expect(feed.locator("span.absolute.h-2\\.5.w-2\\.5")).toHaveCount(all * 4);
  });

  test("moving to the far corner leaves only what is near it", async ({ lab }) => {
    await lab.open();
    await lab.fastForward(2);
    expect(await lab.state((s) => s.detections.filter((d) => d.state === "LOCKED").length)).toBeGreaterThan(0);
    await lab.page.evaluate(() => window.__labStore!.getState().moveGantryTo(0, 0));
    await lab.fastForward(15);
    const ids = await lab.state((s) => s.detections.map((d) => d.objectId));
    // the valve and the far pipe section are more than a footprint away from home
    expect(ids).not.toContain("valve-1");
    expect(ids).not.toContain("pipe-c");
  });

  test("turbidity 1 or lighting 0 detects nothing; threshold gates the count", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(6);
    const turb = page.locator("label", { hasText: "Turbidity" }).locator("input[type=range]");
    await turb.fill("1");
    await lab.fastForward(2);
    expect(await lab.state((s) => s.detections.length)).toBe(0);
    await turb.fill("0.15");
    const light = page.locator("label", { hasText: "Lighting" }).locator("input[type=range]");
    await light.fill("0");
    await lab.fastForward(2);
    expect(await lab.state((s) => s.detections.length)).toBe(0);
    await light.fill("0.8");
    const thr = page.locator("label", { hasText: "Detector threshold" }).locator("input[type=range]");
    await thr.fill("0.3");
    await lab.fastForward(2);
    const low = await lab.state((s) => s.detections.length);
    await thr.fill("0.95");
    await lab.fastForward(2);
    expect(low).toBeGreaterThan(await lab.state((s) => s.detections.length));
  });
});
