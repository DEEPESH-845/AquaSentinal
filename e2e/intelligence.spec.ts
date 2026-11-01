import { expect, test } from "./lab";

/** The new-intelligence view and provenance labels: nothing is shown as live, hackathon-built or model output without backing state. */
test.describe("intelligence", () => {
  test("offline backend: preflight blocks live Meta, the execution log is empty and no step claims a live model", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.scene(8);
    const card = page.getByTestId("intelligence-card");
    await expect(card.getByRole("heading", { name: "New inspection intelligence" })).toBeVisible();
    await expect(page.getByTestId("preflight")).toContainText("live Meta not verified");
    await expect(page.getByTestId("preflight")).toContainText("MODEL_API_KEY not set");
    await expect(page.getByTestId("preflight")).toContainText("SIMULATED gantry: no physical motion");
    await expect(page.getByTestId("execution-log")).toContainText("No Meta request has been made by this backend");
    await expect(card.locator("[data-exec=OFFLINE_FALLBACK]").first()).toBeVisible(); // voice falls back to typing
    await expect(page.locator("[data-exec=LIVE_META]")).toHaveCount(0);

    // an offline plan is labelled as the fallback parser, never as Muse Spark
    await lab.scene(5);
    await page.locator("#instruction").fill("Inspect the pipeline left to right for loose cables.");
    await lab.mission((s) => s.interpret());
    await lab.waitMission((s) => s.mission?.provider === "OFFLINE_RULE_PARSER");
    await lab.scene(8);
    const reasoning = card.locator("li", { hasText: "Mission reasoning" });
    await expect(reasoning.locator("[data-exec]")).toHaveAttribute("data-exec", "OFFLINE_FALLBACK");
    await expect(card.locator("li", { hasText: "Validated plan" }).locator("[data-exec]")).toHaveAttribute("data-exec", "DETERMINISTIC");
  });

  test("a mocked execution is shown as MOCKED, never upgraded to live", async ({ lab, page }) => {
    const mocked = {
      transport: "MOCK_TRANSPORT",
      counts: { MOCKED: 1 },
      executions: [
        {
          id: "exe_1", model: "sam-3.1", operation: "segmentation", inputRef: "capture:cap_1 prompt='cable'", outputRef: "response:resp_1 chars=10",
          requestAt: "2026-11-02T00:00:00.000+00:00", responseAt: "2026-11-02T00:00:00.120+00:00", durationMs: 120, attempts: 1, success: true,
          status: 200, error: null, traceId: "resp_1", transport: "MOCK_TRANSPORT", classification: "MOCKED",
        },
      ],
    };
    await page.route("**/api/evidence/model-executions*", (route) => route.fulfill({ json: mocked, headers: { "access-control-allow-origin": "*" } }));
    await lab.openOnline();
    await lab.scene(8);
    const log = page.getByTestId("execution-log");
    await expect(log).toContainText("sam-3.1 segmentation");
    await expect(log.locator("[data-exec=MOCKED]")).toBeVisible();
    await expect(page.locator("[data-exec=LIVE_META]")).toHaveCount(0);
  });

  test("scene provenance: inherited scenes are never labelled hackathon-built", async ({ lab, page }) => {
    await lab.open();
    const expected: Record<number, string> = { 1: "adapted", 2: "inherited", 3: "new", 4: "inherited", 5: "new", 6: "new", 7: "new", 8: "new" };
    for (const [n, origin] of Object.entries(expected)) {
      await lab.scene(Number(n));
      const tag = page.locator("[data-lab=card] [data-origin]");
      await expect(tag).toHaveAttribute("data-origin", origin);
      if (origin !== "new") await expect(tag).not.toHaveText(/HACKATHON-BUILT/);
    }
  });
});
