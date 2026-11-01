import { expect, test } from "./lab";

test.describe("boot", () => {
  test("loads, renders the scene, connects the backend and publishes canonical state", async ({ lab, page }) => {
    await lab.openOnline();
    await expect(page.getByText("AQUASENTINAL", { exact: true })).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.locator("#gantry-camera-feed")).toBeVisible();
    const t = await lab.state((s) => s.telemetry);
    expect(t.environment.source).toBe("SIMULATED");
    expect([t.gantry.x, t.gantry.y, t.estop]).toEqual([50, 20, false]);
    await expect(page.getByTestId("chip-backend")).toContainText("ONLINE");
    // offline SIMULATION backend: AI providers report OFFLINE, never pretend to be live
    await expect(page.getByTestId("chip-ai")).toContainText("OFFLINE");
    expect(await lab.mission((m) => m.system?.providers.spark.status)).toBe("OFFLINE");
    const calls = await page.evaluate(() => window.__labStats?.calls ?? 0);
    expect(calls).toBeGreaterThan(10);
  });

  test("no horizontal overflow at desktop", async ({ lab, page }) => {
    await lab.open();
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(o.sw).toBeLessThanOrEqual(o.cw);
  });
});
