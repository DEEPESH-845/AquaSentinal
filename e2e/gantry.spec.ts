import { expect, test } from "./lab";

test.describe("gantry", () => {
  test("home, click-to-move, boundaries and stop", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(4);
    await lab.button(/^home$/i).click();
    await lab.fastForward(20);
    await lab.waitFor((s) => s.telemetry.gantry.atHome);

    const pad = page.getByTestId("xy-pad");
    const box = (await pad.boundingBox())!;
    await page.mouse.click(box.x + box.width - 1, box.y + box.height - 1);
    const target = await lab.state((s) => [s.engine.gantry.x.target, s.engine.gantry.y.target]);
    expect(target[0]).toBeLessThanOrEqual(100);
    expect(target[1]).toBeLessThanOrEqual(40);
    expect(target[0]).toBeGreaterThan(95);
    await lab.fastForward(20);
    const pos = await lab.state((s) => [s.telemetry.gantry.x, s.telemetry.gantry.y, s.telemetry.gantry.moving]);
    expect(pos[0]).toBeLessThanOrEqual(100);
    expect(pos[1]).toBeLessThanOrEqual(40);
    expect(pos[2]).toBe(false);
    await expect(lab.card()).toContainText(/Limits\s*X 0\.\.100, Y 0\.\.40 cm/);

    await page.mouse.click(box.x + 2, box.y + 2);
    await lab.fastForward(1);
    await lab.button(/^stop$/i).click();
    // Stop holds the carriage where it was stopped: it decelerates (the twin keeps real time, so a frame may pass before
    // this read) and settles on its stop point instead of continuing to the clicked corner near (0, 0).
    const stopAt = await lab.state((s) => [s.engine.gantry.x.target, s.engine.gantry.y.target]);
    expect(stopAt[0]).toBeGreaterThan(50);
    await lab.fastForward(5);
    const g = await lab.state((s) => s.engine.gantry);
    expect(g.x.target).toBeCloseTo(stopAt[0], 5);
    expect(g.y.target).toBeCloseTo(stopAt[1], 5);
    expect(g.x.pos).toBeCloseTo(g.x.target, 2);
    expect(g.y.pos).toBeCloseTo(g.y.target, 2);
  });

  test("invariants hold under invalid store commands", async ({ lab }) => {
    await lab.open();
    const bad = [NaN, Infinity, -Infinity, -5, 1e9, null, undefined] as unknown as number[];
    for (const x of bad)
      for (const y of bad) {
        await lab.page.evaluate(([a, b]) => window.__labStore!.getState().moveGantryTo(a as number, b as number), [x, y]);
        await lab.fastForward(0.5);
        const g = await lab.state((s) => s.engine.gantry);
        for (const a of [g.x, g.y]) {
          expect(Number.isFinite(a.pos)).toBe(true);
          expect(Number.isFinite(a.target)).toBe(true);
        }
        expect(g.x.pos).toBeGreaterThanOrEqual(0);
        expect(g.x.pos).toBeLessThanOrEqual(100);
        expect(g.y.pos).toBeGreaterThanOrEqual(0);
        expect(g.y.pos).toBeLessThanOrEqual(40);
      }
  });

  test("centre on an object moves the carriage over it", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(4);
    await lab.card().getByRole("button", { name: /dropped wrench/i }).click();
    await lab.waitFor((s) => s.mode === "TRACK");
    await lab.fastForward(15);
    const [g, o] = await lab.state((s) => [s.telemetry.gantry, s.scenario.objects.find((x) => x.id === "wrench-1")!]);
    expect(Math.hypot(g.x - o.x, g.y - o.y)).toBeLessThan(3);
    void page;
  });
});
