import type { Page } from "@playwright/test";
import { expect, test } from "./lab";

/** Two animation frames, enough for a state change to reach the DOM. */
const frames = (page: Page, n = 2) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((r) => requestAnimationFrame(r));
  }, n);

test.describe("demo", () => {
  test("INTRO to REPORT with the backend's plan, one pause, a completed mission and its metrics", async ({ lab, page }) => {
    // The demo clock only advances with rendered frames (software GL: a few per second), so phases take wall time.
    // The engine is fast-forwarded in slices while the mission runs; the phase minimums still have to elapse.
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1024, height: 640 });
    await lab.openOnline();
    await page.evaluate(() => {
      const seen: number[] = [window.__labStore!.getState().demo.phase];
      (window as unknown as { __phases: number[] }).__phases = seen;
      window.__labStore!.subscribe((s) => {
        if (seen[seen.length - 1] !== s.demo.phase) seen.push(s.demo.phase);
      });
    });
    await lab.button(/run demo/i).click();
    // the judge demo opens on the new-intelligence view, not the inherited tank overview
    await lab.waitFor((s) => s.demo.active && s.scene === 8);
    await expect(page.getByTestId("intelligence-card")).toHaveCount(0); // the demo card replaces the scene card
    await expect(lab.rail(/^02/)).toBeDisabled();
    await expect(lab.button(/^reset lab$/i)).toBeDisabled();

    // offline the instruction is typed, and the COMMAND card says so instead of showing a transcript
    await lab.waitFor((s) => s.demo.phase === 1, undefined, 120_000);
    await expect(lab.card().getByText(/Typed instruction: Voice Transcribe needs MODEL_API_KEY/)).toBeVisible();

    // INTRO, COMMAND and PLAN run on their own; the plan must come from the backend, not the built-in fixture
    await lab.waitFor((s) => s.demo.phase >= 3, undefined, 300_000);
    expect(await lab.state((s) => s.demo.usedFixture)).toBe(false);
    const planId = await lab.state((s) => s.demo.plan?.missionId);
    expect(planId).toMatch(/^pipeline-/);
    expect(await lab.mission((s) => s.mission?.id)).toBe(planId);
    expect(await lab.mission((s) => s.mission?.provider)).toBe("OFFLINE_RULE_PARSER");

    // SCAN, PERCEIVE and ADAPT: tick the engine until the mission has ended, then let the demo clock finish the phases
    await lab.fastForwardUntil((s) => s.demo.phase >= 6 || (s.mode !== "MISSION" && s.missionResult !== null), undefined, 200, 1);
    await lab.waitFor((s) => s.demo.phase >= 6, undefined, 300_000);

    const phases = await page.evaluate(() => (window as unknown as { __phases: number[] }).__phases);
    expect(phases).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const result = await lab.state((s) => s.missionResult!);
    expect(result.outcome).toBe("COMPLETED");
    expect(result.pauses).toBeGreaterThanOrEqual(1);
    expect(result.waypointsVisited).toBe(result.waypointsPlanned);
    expect(await lab.state((s) => s.demo.usedFixture)).toBe(false);

    // the backend recorded the same mission as completed, with the captures the twin took
    await lab.waitMission((s) => s.mission?.status === "COMPLETED" && s.report?.mission.id === s.mission.id, undefined, 60_000);
    expect(await lab.mission((s) => s.report!.path.length)).toBe(result.captures);

    // the REPORT card shows the mission metrics
    const card = lab.card();
    await expect(card.getByRole("heading", { name: "Inspection report" })).toBeVisible();
    const metric = (label: string) => card.getByText(label, { exact: true }).locator("xpath=following-sibling::*[1]");
    await expect(metric("Outcome")).toHaveText("COMPLETED");
    await expect(metric("Captures")).toHaveText(String(result.captures).padStart(2, "0"));
    await expect(metric("Pauses")).toHaveText(String(result.pauses).padStart(2, "0"));
    await expect(metric("Targets")).toHaveText(String(result.confirmedTargets).padStart(2, "0"));
    await expect(metric("Coverage")).toHaveText(`${(result.coverage * 100).toFixed(0)}%`);

    // the closing moment follows, Escape leaves the demo, and the lab is usable again
    await expect(page.getByText(/From simulation to field/)).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press("Escape");
    await lab.waitFor((s) => !s.showVision && !s.demo.active);
    await expect(lab.rail(/^02/)).toBeEnabled();
    await expect(lab.button(/^reset lab$/i)).toBeEnabled();
  });

  test("pause freezes the demo clock and sim time, and says so; replay and exit return to a clean lab", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.button(/run demo/i).click();
    await lab.waitFor((s) => s.demo.active);
    await lab.button(/^pause$/i).click();
    await lab.waitFor((s) => s.demo.paused);
    await frames(page, 3); // the last published clock value lands within a few frames of the pause
    const before = await lab.state((s) => [s.engine.time, s.demo.t]);
    await frames(page, 10);
    expect(await lab.state((s) => [s.engine.time, s.demo.t])).toEqual(before);
    await expect(page.getByText("PAUSED", { exact: true })).toBeVisible();
    await expect(lab.button(/^reset lab$/i)).toBeDisabled();

    await lab.button(/^resume$/i).click();
    await lab.waitFor((s) => !s.demo.paused && s.demo.t > 0);
    await lab.button(/replay/i).click();
    await lab.waitFor((s) => s.demo.active && s.demo.phase === 0 && s.demo.t < 1);
    await lab.button(/exit demo/i).click();
    await lab.waitFor((s) => !s.demo.active);
    expect(await lab.state((s) => [s.mode, s.demo.plan])).toEqual(["IDLE", null]);
    await lab.button(/^reset lab$/i).click();
    expect(await lab.state((s) => [s.mode, s.preset, s.scenario.disturbances.length, s.missionResult])).toEqual(["IDLE", null, 0, null]);
  });
});
