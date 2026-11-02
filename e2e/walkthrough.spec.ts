import type { Page } from "@playwright/test";
import { expect, test } from "./lab";

declare global {
  interface Window {
    /** dev-only, set by the walkthrough page: live ScrollTrigger count */
    __scrollTriggers?: () => number;
  }
}

const HEADINGS = [
  /the deeper the inspection/i,
  /a camera gantry over a pipeline/i,
  /from a sentence to a bounded mission/i,
  /outlines, not guesses/i,
  /when the water clouds/i,
  /from a camera feed to an intelligent inspection system/i,
  /enter the lab/i,
];

const turbidity = (page: Page) => page.evaluate(() => window.__labStore!.getState().engine.scenario.turbidity);
const triggers = (page: Page) => page.evaluate(() => window.__scrollTriggers?.() ?? -1);

async function openWalkthrough(page: Page) {
  await page.goto("/walkthrough");
  await page.waitForFunction(() => !!window.__labStore && (window.__scrollTriggers?.() ?? 0) > 0);
}

test.describe("walkthrough", () => {
  test("renders all seven sections", async ({ page, audit }) => {
    void audit;
    await openWalkthrough(page);
    for (const h of HEADINGS) await expect(page.getByRole("heading", { name: h })).toBeAttached();
  });

  test("section 05 drives the twin's turbidity by scroll and by the range input", async ({ page, audit }) => {
    void audit;
    await openWalkthrough(page);
    const before = await turbidity(page);
    // into the pinned/scrubbed range of section 05
    await page.evaluate(() => {
      const el = document.getElementById("adaptive")!;
      const top = (el.closest(".pin-spacer") ?? el).getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, top + window.innerHeight * 0.6);
    });
    await expect.poll(() => turbidity(page)).not.toBeCloseTo(before, 2);
    const scrolled = await turbidity(page);
    expect(scrolled).toBeGreaterThan(0.1);

    const slider = page.getByRole("slider", { name: "Turbidity of the twin water" });
    await slider.fill("0.9");
    await expect.poll(() => turbidity(page)).toBeCloseTo(0.9, 2);
    await expect(page.getByTestId("wt-visibility")).toContainText("UNSAFE");
  });

  test("the call to action opens mission control", async ({ page, audit }) => {
    void audit;
    await openWalkthrough(page);
    await page.getByRole("link", { name: "Enter mission control" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: /Underwater inspection lab/ })).toBeVisible();
  });

  test("leaving and re-entering does not leak ScrollTriggers and restores the water", async ({ page, audit }) => {
    void audit;
    await openWalkthrough(page);
    const original = await turbidity(page);
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      // client-side navigation both ways, so module state (ScrollTrigger, the twin store) survives like it does for a user
      if (i > 0) {
        await page.goBack();
        await expect(page).toHaveURL(/\/walkthrough$/);
      }
      await expect.poll(() => triggers(page)).toBeGreaterThan(0);
      counts.push(await triggers(page));
      // scroll to the slider first and let ScrollTrigger apply that scroll (it does so on the next frame), then drag
      const slider = page.getByRole("slider", { name: "Turbidity of the twin water" });
      await slider.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await slider.fill("0.8");
      await expect.poll(() => turbidity(page)).toBeCloseTo(0.8, 2);
      await page.getByRole("link", { name: "Mission control", exact: true }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("heading", { name: /Underwater inspection lab/ })).toBeVisible();
      await expect.poll(() => turbidity(page)).toBeCloseTo(original, 3);
      expect(await triggers(page)).toBe(0);
    }
    expect(new Set(counts).size, `trigger counts per visit ${counts.join(", ")}`).toBe(1);
  });
});
