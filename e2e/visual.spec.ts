import { expect, test } from "./lab";

/** One composition snapshot per scene, in the lab's default state. 3D is software-rendered, so the tolerance is loose. */
test.describe("visual", () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`scene ${n}`, async ({ lab, page }) => {
      // earlier specs leave missions in the backend; the report scene's history list must not depend on them
      await page.route("**/api/inspection/history", (route) => route.fulfill({ json: [], headers: { "access-control-allow-origin": "*" } }));
      await lab.openOnline();
      await lab.scene(n);
      // the camera tween and the card transition must be over before the picture is taken
      await page.waitForFunction(() => window.__labCamera && !window.__labCamera.tweening());
      // the follow camera keeps easing after the preset tween ends: wait until it has not moved for ten frames
      await page.evaluate(async () => {
        const pos = () => Object.values({ ...window.__labCamera!.camera.position });
        let last = pos();
        for (let still = 0; still < 10; ) {
          await new Promise((r) => requestAnimationFrame(r));
          const now = pos();
          still = now.every((v, i) => Math.abs(v - last[i]) < 1e-4) ? still + 1 : 0;
          last = now;
        }
      });
      await lab.waitFor(() => !document.querySelector("[data-lab=card] [style*='opacity: 0']"));
      await expect(page).toHaveScreenshot(`scene${n}.png`, { maxDiffPixelRatio: 0.04, animations: "disabled" });
    });
  }
});
