import { expect, test } from "./lab";

const SCENES = [
  [1, "Overview", /Underwater inspection lab/],
  [2, "System", /System architecture/],
  [3, "Perception", /AI perception/],
  [4, "Navigation", /Gantry and navigation/],
  [5, "Mission", /AI mission control/],
  [6, "Environment", /Environment and scenario/],
  [7, "Report", /Inspection report/],
] as const;

test.describe("navigation", () => {
  test("every scene opens from the rail with its card and camera preset", async ({ lab, page }) => {
    await lab.open();
    for (const [n, name, title] of SCENES) {
      await expect(lab.rail(new RegExp(`^0${n}`))).toContainText(name);
      await lab.scene(n);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      expect(await lab.state((s) => s.cameraPreset)).toMatch(/^[A-E]$/);
    }
  });

  test("keyboard 1..7 and arrows navigate; typing in inputs does not", async ({ lab, page }) => {
    await lab.open();
    await page.keyboard.press("4");
    await lab.waitFor((s) => s.scene === 4);
    await page.keyboard.press("ArrowDown");
    await lab.waitFor((s) => s.scene === 5);
    await page.keyboard.press("ArrowUp");
    await lab.waitFor((s) => s.scene === 4);
    await lab.scene(5);
    await page.locator("#instruction").focus();
    await page.keyboard.type("3 cables");
    expect(await lab.state((s) => s.scene)).toBe(5);
    await expect(page.locator("#instruction")).toHaveValue("3 cables");
  });

  test("rapid scene switching ends in a consistent state", async ({ lab }) => {
    await lab.open();
    for (let i = 0; i < 12; i++) await lab.rail(new RegExp(`^0${(i % 7) + 1}`)).click({ delay: 0 });
    await lab.waitFor((s) => s.scene === 5);
    expect(await lab.state((s) => s.cameraPreset)).toBe("A");
  });
});
