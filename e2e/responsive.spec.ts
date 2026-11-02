import { expect, test } from "./lab";

const SIZES = [
  [320, 568],
  [390, 844],
  [667, 375],
  [844, 390],
  [900, 700],
  [768, 1024],
  [1024, 768],
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
] as const;

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const [w, h] of SIZES) {
  test(`${w}x${h}: brand and controls fit, nothing overflows, the card never covers the feed`, async ({ lab, page }) => {
    await page.setViewportSize({ width: w, height: h });
    await lab.open();
    const overflow = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }));
    expect(await overflow()).toEqual({ doc: 0, body: 0 });

    // the brand is whole: visible, inside the viewport, and not clipped by the container that holds it
    const brand = page.getByText("AQUASENTINAL", { exact: true });
    await expect(brand).toBeVisible();
    const clipped = await brand.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const p = el.parentElement!.getBoundingClientRect();
      return r.right > p.right + 0.5 || r.right > window.innerWidth;
    });
    expect(clipped).toBe(false);

    // the controls that must always be reachable are inside the viewport
    for (const name of [/^run demo$/i, /^reset lab$/i, /^emergency stop$/i]) {
      const b = (await lab.button(name).boundingBox())!;
      expect(b, String(name)).not.toBeNull();
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(w + 1);
      expect(b.y + b.height).toBeLessThanOrEqual(h + 1);
    }
    await expect(page.locator("#gantry-camera-feed")).toBeVisible();

    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      await lab.scene(n);
      await expect(lab.card().getByRole("heading").first()).toBeVisible();
      const card = (await lab.card().locator(".panel").first().boundingBox())!;
      const feed = (await page.locator("#gantry-camera-feed").boundingBox())!;
      expect(card.x, `scene ${n} card left`).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width, `scene ${n} card right`).toBeLessThanOrEqual(w + 1);
      expect(card.y, `scene ${n} card top`).toBeGreaterThanOrEqual(0);
      expect(card.y + card.height, `scene ${n} card bottom`).toBeLessThanOrEqual(h + 1);
      expect(overlaps(card, feed), `scene ${n} card covers the feed`).toBe(false);
      expect(await overflow(), `scene ${n} overflow`).toEqual({ doc: 0, body: 0 });
      // the scene strip fits without scrolling at every width
      const nav = await page.locator("[data-lab=nav]").evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(nav, `scene ${n} scene strip overflow`).toBeLessThanOrEqual(1);
    }
  });
}
