import { expect, test } from "./lab";

test.describe("emergency stop", () => {
  test("latches the twin and the backend gate, blocks motion and approval, clears on request", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.scene(4);
    await page.evaluate(() => window.__labStore!.getState().moveGantryTo(90, 35));
    await lab.fastForward(1);
    expect(await lab.state((s) => s.telemetry.gantry.moving)).toBe(true);
    await lab.button(/^emergency stop$/i).click();
    const g = await lab.state((s) => ({ estop: s.telemetry.estop, vx: s.engine.gantry.x.vel, vy: s.engine.gantry.y.vel }));
    expect(g).toEqual({ estop: true, vx: 0, vy: 0 });
    await expect(lab.card().getByText(/Emergency stop latched/)).toBeVisible();
    // the backend motion gate latched too
    await expect.poll(async () => (await (await page.request.get("http://localhost:8000/api/telemetry")).json()).gantry.estop).toBe(true);

    const here = await lab.state((s) => [s.telemetry.gantry.x, s.telemetry.gantry.y]);
    const box = (await page.getByTestId("xy-pad").boundingBox())!;
    await page.mouse.click(box.x + 5, box.y + 5);
    await lab.button(/^home$/i).click({ force: true }).catch(() => undefined);
    await lab.fastForward(3);
    expect(await lab.state((s) => [s.telemetry.gantry.x, s.telemetry.gantry.y])).toEqual(here);

    await lab.planExample();
    await expect(lab.button(/approve and run/i)).toBeDisabled();

    await lab.button(/clear e-stop/i).click();
    await lab.waitFor((s) => !s.telemetry.estop);
    await expect(lab.button(/approve and run/i)).toBeEnabled();
    await expect(lab.button(/^emergency stop$/i)).toBeVisible();
    await expect.poll(async () => (await (await page.request.get("http://localhost:8000/api/telemetry")).json()).gantry.estop).toBe(false);
  });

  test("an e-stop during a mission ends it as EMERGENCY_STOP", async ({ lab }) => {
    test.setTimeout(180_000);
    await lab.openOnline();
    await lab.planExample();
    await lab.button(/approve and run/i).click();
    await lab.waitFor((s) => s.mode === "MISSION");
    await lab.fastForwardUntil((s) => s.mission?.status === "RUNNING" && s.telemetry.gantry.moving, undefined, 30, 0.5);
    await lab.button(/^emergency stop$/i).click();
    await lab.waitFor((s) => s.missionResult?.outcome === "EMERGENCY_STOP" && s.mode === "IDLE");
    await lab.waitMission((s) => s.mission?.status === "ABORTED", undefined, 30_000);
    await lab.button(/clear e-stop/i).click();
    await lab.waitFor((s) => !s.telemetry.estop);
  });

  test("a backend latch that outlives the twin's reset still shows as latched; approve says how to clear it", async ({ lab, page, audit }) => {
    audit.allow.push(/Failed to load resource: the server responded with a status of 409/);
    const backendEstop = async () => (await (await page.request.get("http://localhost:8000/api/telemetry")).json()).gantry.estop as boolean;
    await lab.openOnline();
    await lab.button(/^emergency stop$/i).click();
    await expect.poll(backendEstop).toBe(true);
    // Reset lab clears the twin's latch only; the backend motion controller keeps its own
    await lab.button(/^reset lab$/i).click();
    await lab.waitFor((s) => !s.telemetry.estop);
    await lab.mission((s) => s.refreshStatus());
    const clear = lab.button(/clear e-stop/i);
    await expect(clear).toBeVisible();
    await expect(clear).toHaveAttribute("title", /latched on the backend motion controller/);

    // the twin is clear, so approve is offered; the backend refuses and the card says what to do
    await lab.planExample();
    await lab.button(/approve and run/i).click();
    await expect(lab.card().getByText(/Clear it with the Clear e-stop button in the top bar/)).toBeVisible();
    expect(await lab.state((s) => s.mode)).toBe("IDLE");

    await clear.click();
    await expect(lab.button(/^emergency stop$/i)).toBeVisible();
    await expect.poll(backendEstop).toBe(false);
    await lab.button(/approve and run/i).click();
    await lab.waitFor((s) => s.mode === "MISSION");
    await lab.waitMission((s) => s.mission?.status === "RUNNING");
  });
});
