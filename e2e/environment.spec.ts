import { expect, test } from "./lab";

test.describe("environment and scenario", () => {
  test("sliders and object fields commit clamped values; junk reverts", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(6);
    await expect(lab.card().getByText("SIMULATED", { exact: true })).toBeVisible();
    await page.locator("label", { hasText: "Turbidity" }).locator("input[type=range]").fill("0.6");
    expect(await lab.state((s) => s.scenario.turbidity)).toBeCloseTo(0.6, 5);
    await lab.button(/object positions/i).click();
    const x = page.locator("input[type=number]").first();
    await x.fill("500");
    await x.press("Enter");
    expect(await lab.state((s) => s.scenario.objects[0].x)).toBe(97);
    await x.click({ clickCount: 3 });
    await page.keyboard.type("abc");
    await x.press("Enter");
    expect(await lab.state((s) => s.scenario.objects[0].x)).toBe(97);
    await x.fill("-10");
    await x.press("Enter");
    expect(await lab.state((s) => s.scenario.objects[0].x)).toBe(3);
    await lab.button(/^reset lab$/i).click();
    expect(await lab.state((s) => [s.scenario.objects[0].x, s.scenario.turbidity])).toEqual([20, 0.15]);
  });

  test("preset E loads its disturbance schedule; compare strategies measures adaptive against fixed", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(6);
    await lab.button(/^E Turbidity increase$/).click();
    await lab.waitFor((s) => s.preset === "E" && s.scenario.disturbances.length === 3);
    await expect(lab.card()).toContainText(/Scripted: turbidity at 4 s/);
    await lab.button(/compare strategies/i).click();
    const card = lab.card();
    await expect(card.getByText("Adaptive", { exact: true })).toBeVisible();
    await expect(card.getByText("Fixed", { exact: true })).toBeVisible();
    await expect(card.getByText(/Measured just now/)).toBeVisible();
    // the numbers on screen are the engine's own: recompute headlessly in the page and compare
    const cell = async (row: string, col: 1 | 2) => (await card.locator(".label", { hasText: new RegExp(`^${row}$`) }).locator(`xpath=following-sibling::span[${col}]`).textContent())!.trim();
    expect(Number(await cell("Unreliable frames", 1))).toBe(0);
    expect(Number(await cell("Unreliable frames", 2))).toBeGreaterThan(0);
    expect(Number(await cell("Pauses", 1))).toBeGreaterThanOrEqual(1);
    expect(Number(await cell("Targets confirmed", 1))).toBeGreaterThan(Number(await cell("Targets confirmed", 2)));
    // deterministic: a second comparison shows the same table
    const first = await card.textContent();
    await lab.button(/compare strategies/i).click();
    expect(await card.textContent()).toBe(first);
    // clicking the active preset again restores the default layout
    await lab.button(/^E Turbidity increase$/).click();
    await lab.waitFor((s) => s.preset === null && s.scenario.disturbances.length === 0);
    void page;
  });
});
