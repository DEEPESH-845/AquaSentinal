import { expect, test } from "./lab";

/** Mission-control refinements: panels, guided tour, honest status, perception views, mission state, keyboard gantry. */
test.describe("refinement", () => {
  test("panels collapse and expand, F toggles focus, the camera refits to the freed space", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.scene(6);
    const card = page.locator("[data-lab=card]");
    const before = (await card.boundingBox())!.height;

    await card.getByRole("button", { name: "Collapse panel" }).click();
    await expect(card.getByRole("button", { name: /Expand the Environment panel/ })).toBeVisible();
    expect((await card.boundingBox())!.height).toBeLessThan(before / 3);
    await card.getByRole("button", { name: /Expand the Environment panel/ }).click();
    await expect(card.getByRole("heading", { name: "Environment and scenario" })).toBeVisible();

    await page.getByRole("button", { name: "Collapse telemetry" }).click();
    await expect(page.getByTestId("mission-log")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand telemetry" }).click();
    await expect(page.getByTestId("mission-log")).toBeVisible();

    // focus view, repeatedly: both panels go and come back together
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("f");
      await lab.waitFor((s) => !s.panels.card && !s.panels.telemetry);
      await page.keyboard.press("f");
      await lab.waitFor((s) => s.panels.card && s.panels.telemetry);
    }
    await page.getByTestId("focus-toggle").click();
    await lab.waitFor((s) => !s.panels.card);
    await page.getByTestId("focus-toggle").click();
    await lab.waitFor((s) => s.panels.card);
  });

  test("the guided tour steps through nine steps, switches scenes, reports only what the user did, and closes", async ({ lab, page }) => {
    await lab.openOnline();
    await page.getByTestId("start-tour").click();
    const tour = page.getByTestId("tour");
    await expect(tour.getByText("Guide 01 / 09")).toBeVisible();

    // step 4 (issue a command) says it is waiting, because nothing has been planned
    for (let i = 0; i < 3; i++) await tour.getByRole("button", { name: "Next step" }).click();
    await expect(tour.getByText("Guide 04 / 09")).toBeVisible();
    await lab.waitFor((s) => s.scene === 5);
    await expect(tour.getByRole("status")).toContainText("Waiting for you");

    // controls under the spotlight stay usable: plan from inside the tour, and the step reports it
    await lab.card().getByRole("button", { name: /use the example instruction/i }).click();
    await lab.card().getByRole("button", { name: /plan mission/i }).click();
    await lab.waitMission((m) => m.mission?.status === "PLANNED", undefined, 30_000);
    await expect(tour.getByRole("status")).toContainText(/Mission .* planned/);

    // arrow keys step; Back works; the last step finishes
    await page.keyboard.press("ArrowRight");
    await expect(tour.getByText("Guide 05 / 09")).toBeVisible();
    await tour.getByRole("button", { name: "Previous step" }).click();
    await expect(tour.getByText("Guide 04 / 09")).toBeVisible();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await expect(tour.getByText("Guide 09 / 09")).toBeVisible();
    await lab.waitFor((s) => s.scene === 7);
    await tour.getByRole("button", { name: "Finish the guide" }).click();
    await expect(tour).toHaveCount(0);

    // restartable, and Escape closes
    await page.getByTestId("start-tour").click();
    await expect(page.getByTestId("tour").getByText("Guide 01 / 09")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tour")).toHaveCount(0);
    await lab.scene(5);
    await lab.card().getByRole("button", { name: "Discard" }).click();
  });

  test("an unreachable backend shows UNKNOWN or offline, never a stale healthy state", async ({ lab, page, audit }) => {
    audit.allow.push(/localhost:8000/, /Failed to load resource/, /ERR_FAILED/, /WebSocket/i);
    await page.route("http://localhost:8000/**", (r) => r.abort("failed"));
    await page.routeWebSocket(/localhost:8000/, (ws) => ws.close());
    await lab.open();
    await lab.waitMission((s) => s.backend === "OFFLINE", undefined, 30_000);
    await expect(page.getByTestId("chip-mode")).toContainText("UNKNOWN");
    await expect(page.getByTestId("chip-ai")).toContainText("UNKNOWN");
    await lab.scene(2);
    const health = page.getByTestId("system-health");
    await expect(health.locator("[data-status=LIVE], [data-status=ON]")).toHaveCount(0);
    await expect(health.locator("[data-status=UNKNOWN]")).toHaveCount(6);
  });

  test("mission state strip follows the real request, and planning can be cancelled", async ({ lab, page, audit }) => {
    audit.allow.push(/api\/ai\/interpret net::ERR_ABORTED/); // the cancelled request, aborted on purpose
    await lab.openOnline();
    await lab.scene(5);
    const strip = page.getByTestId("mission-state");
    await expect(strip).toHaveAttribute("data-state", "IDLE");
    await lab.card().getByRole("button", { name: /use the example instruction/i }).click();
    await expect(strip).toHaveAttribute("data-state", "READY");

    // hold the planning request so the pending state is observable, then cancel it
    let release: () => void = () => undefined;
    await page.route("**/api/ai/interpret*", async (route) => {
      await new Promise<void>((r) => (release = r));
      await route.continue().catch(() => undefined);
    });
    await lab.card().getByRole("button", { name: /plan mission/i }).click();
    await expect(strip).toHaveAttribute("data-state", "INTERPRETING");
    await lab.card().getByRole("button", { name: "Cancel planning" }).click();
    await expect(strip).toHaveAttribute("data-state", "FAILED");
    await expect(lab.card().getByText(/Planning cancelled/)).toBeVisible();
    release();
    await page.unroute("**/api/ai/interpret*");

    await lab.card().getByRole("button", { name: /plan mission/i }).click();
    await lab.waitMission((m) => m.mission?.status === "PLANNED", undefined, 30_000);
    await expect(strip).toHaveAttribute("data-state", "AWAITING_APPROVAL");
    await lab.card().getByRole("button", { name: "Discard" }).click();
  });

  test("perception views switch by mouse and keyboard and the compare divider is a range input", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.scene(3);
    await lab.card().getByRole("button", { name: /^capture$/i }).click();
    await lab.waitMission((s) => s.captures.length > 0 && s.captures.at(-1)!.status === "DONE", undefined, 30_000);
    // a populated Perception card is tall; it must still stay clear of the widened feed column
    await page.waitForTimeout(600);
    const card = (await page.locator("[data-lab=card] .panel").first().boundingBox())!;
    const column = (await page.locator("[data-lab=column]").boundingBox())!;
    expect(card.x + card.width, "card right edge vs column left edge").toBeLessThanOrEqual(column.x);
    const views = lab.card().getByRole("radiogroup", { name: "Frame view" });
    await views.getByRole("radio", { name: "Raw" }).click();
    await expect(views.getByRole("radio", { name: "Raw" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowRight");
    await expect(views.getByRole("radio", { name: "Masks" })).toHaveAttribute("aria-checked", "true");
    await lab.card().getByRole("button", { name: "Compare" }).click();
    const divider = lab.card().getByRole("slider", { name: "Comparison divider position" });
    await divider.fill("20");
    await expect(divider).toHaveValue("20");
  });

  test("the gantry plan view moves the carriage from the keyboard", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.scene(4);
    const x0 = await lab.state((s) => s.engine.gantry.x.target);
    await page.getByTestId("xy-pad").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await lab.waitFor((s, x) => Math.abs(s.engine.gantry.x.target - (x + 10)) < 0.01, x0);
    // the keys moved the gantry, not the scene rail
    expect(await lab.state((s) => s.scene)).toBe(4);
  });
});

test.describe("reduced motion", () => {
  test("camera presets snap instead of tweening, and the walkthrough pins nothing", async ({ lab, page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await lab.openOnline();
    await page.waitForTimeout(1200); // past the first second after mount, when every fit snaps anyway
    await lab.scene(4);
    expect(await page.evaluate(() => window.__labCamera!.tweening())).toBe(false);
    await page.goto("/walkthrough");
    await page.waitForFunction(() => (window.__scrollTriggers?.() ?? 0) > 0);
    await expect(page.locator(".pin-spacer")).toHaveCount(0);
    // every section's copy is visible without scrolling animations having run
    await expect(page.getByRole("heading", { name: /from a camera feed to an intelligent inspection system/i })).toHaveCSS("opacity", "1");
  });
});

test("the walkthrough leaves a running mission's water alone", async ({ lab, page }) => {
  await lab.openOnline();
  await lab.planExample();
  await lab.card().getByRole("button", { name: /approve and run/i }).click();
  await lab.waitFor((s) => s.mode === "MISSION");
  const before = await lab.state((s) => s.engine.scenario.turbidity);
  await page.getByRole("link", { name: "Walkthrough" }).click();
  await expect(page).toHaveURL(/walkthrough/);
  const slider = page.getByRole("slider", { name: "Turbidity of the twin water" });
  await expect(slider).toBeDisabled();
  await expect(page.getByText(/An inspection is running in mission control/)).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.getElementById("adaptive")!.getBoundingClientRect().top + window.scrollY + window.innerHeight * 0.6));
  await page.waitForTimeout(500);
  expect(await lab.state((s) => s.engine.scenario.turbidity)).toBeCloseTo(before, 5);
  await page.getByRole("link", { name: "Mission control", exact: true }).click();
  await lab.waitFor((s) => s.mode === "MISSION");
  await lab.scene(5);
  await lab.card().getByRole("button", { name: "Stop mission" }).click();
  await lab.waitFor((s) => s.mode !== "MISSION");
});
