import { expect, test } from "./lab";

const SCENE_PRESET: Record<number, string> = { 1: "A", 2: "A", 3: "D", 4: "B", 5: "A", 6: "B", 7: "A" };

test.describe("camera", () => {
  test("each scene sets its preset", async ({ lab }) => {
    await lab.open();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await lab.scene(n);
      expect(await lab.state((s) => s.cameraPreset)).toBe(SCENE_PRESET[n]);
    }
  });

  test("follow preset moves with the carriage", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(3);
    await page.waitForFunction(() => window.__labCamera?.tweening(), null, { timeout: 5000 }).catch(() => undefined);
    await page.waitForFunction(() => window.__labCamera && !window.__labCamera.tweening());
    const before = await page.evaluate(() => ({ ...window.__labCamera!.camera.position }));
    await page.evaluate(() => window.__labStore!.getState().moveGantryTo(10, 5));
    await lab.fastForward(20);
    await page.waitForFunction((bx) => !window.__labCamera!.tweening() && Math.abs(window.__labCamera!.camera.position.x - bx) > 0.3, before.x);
    const after = await page.evaluate(() => ({ ...window.__labCamera!.camera.position }));
    expect((await lab.state((s) => s.telemetry.gantry)).x).toBeCloseTo(10, 0);
    // carriage moved 40 cm in -X: the camera follows by about the same amount
    expect(before.x - after.x).toBeGreaterThan(0.3);
    expect(before.x - after.x).toBeLessThan(0.5);
  });

  test("feed orientation: feed right is +X, feed down is +Y", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(3);
    // park so the gate valve (50, 20) sits up-left of the optical axis: it must appear in the upper-left quadrant
    await page.evaluate(() => window.__labStore!.getState().moveGantryTo(58, 26));
    await lab.fastForward(10);
    await lab.waitFor((s) => s.detections.some((d) => d.objectId === "valve-1"));
    const d = await lab.state((s) => s.detections.find((x) => x.objectId === "valve-1")!);
    const [u, v, w, h] = d.bbox;
    expect(u + w / 2).toBeLessThan(0.5);
    expect(v + h / 2).toBeLessThan(0.5);
    expect(d.estX).toBeCloseTo(50, -1);
    expect(d.estY).toBeCloseTo(20, -1);
  });

  test("rapid preset switching and reset mid-tween settle without errors", async ({ lab, page }) => {
    await lab.open();
    for (let i = 0; i < 10; i++) {
      await lab.rail(/^03/).click();
      await lab.rail(/^04/).click();
      await lab.rail(/^01/).click();
    }
    await lab.button(/^reset lab$/i).click();
    await page.waitForFunction(() => window.__labCamera && !window.__labCamera.tweening());
    expect(await lab.state((s) => s.cameraPreset)).toBe("A");
  });
});
