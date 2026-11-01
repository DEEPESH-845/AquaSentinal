import { expect, test } from "./lab";

test.describe("backend offline", () => {
  test("the twin keeps working, the UI says the backend is down and refuses to plan", async ({ lab, page, audit }) => {
    // every request to the backend fails, as if it were not running
    audit.allow.push(/localhost:8000/, /Failed to load resource/, /ERR_FAILED/, /WebSocket/i);
    await page.route("http://localhost:8000/**", (r) => r.abort("failed"));
    await page.routeWebSocket(/localhost:8000/, (ws) => ws.close());
    await lab.open();
    await lab.waitMission((s) => s.backend === "OFFLINE", undefined, 30_000);
    await expect(page.getByTestId("chip-backend")).toContainText("OFFLINE");

    // the simulation is local and unaffected
    await lab.scene(4);
    const box = (await page.getByTestId("xy-pad").boundingBox())!;
    await page.mouse.click(box.x + 10, box.y + 10);
    await lab.fastForward(15);
    const g = await lab.state((s) => s.telemetry.gantry);
    expect(g.x).toBeLessThan(10);
    expect(g.moving).toBe(false);

    await lab.scene(5);
    await page.locator("#instruction").fill("inspect the pipeline for loose cables");
    await expect(lab.button(/plan mission/i)).toBeDisabled();
    await expect(lab.card().getByText(/Backend offline: missions need the backend/)).toBeVisible();

    // captures are kept locally and labelled, not lost silently
    await lab.scene(3);
    await lab.card().getByRole("button", { name: /^capture$/i }).click();
    await lab.waitMission((s) => s.captures.length === 1 && s.captures[0].status === "NOT_SENT");
    await expect(lab.card().getByText(/backend offline: frame kept locally only/)).toBeVisible();
    await lab.scene(7);
    await expect(lab.card().getByText(/It is offline/)).toBeVisible();
  });
});
