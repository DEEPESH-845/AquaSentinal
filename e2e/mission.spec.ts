import { expect, test } from "./lab";

test.describe("AI mission", () => {
  test("instruction -> offline plan -> approve -> twin run with captures -> backend report", async ({ lab, page }) => {
    test.setTimeout(300_000);
    await lab.openOnline();
    await lab.planExample();
    const card = lab.card();
    // no MODEL_API_KEY in e2e: the provenance must say so, never Muse Spark
    await expect(card.getByText("OFFLINE FALLBACK").first()).toBeVisible();
    await expect(card.getByText(/offline keyword parser/)).toBeVisible();
    await expect(card).toContainText("loose cable, foreign object, pipe joint");
    await expect(card).toContainText("6 waypoints, 6 captures");
    await expect(card.getByText("create_inspection_mission")).toBeVisible();
    const m = await lab.mission((s) => s.mission!);
    expect(m.provider).toBe("OFFLINE_RULE_PARSER");
    expect(m.plan.waypoints.map((w) => w.x)).toEqual([10, 26, 42, 58, 74, 90]);

    await lab.button(/approve and run/i).click();
    await lab.waitFor((s) => s.mode === "MISSION" && s.scene === 4);
    await lab.waitMission((s) => s.mission?.status === "RUNNING");
    await lab.fastForwardUntil((s) => s.mode !== "MISSION", undefined, 200);
    const result = await lab.state((s) => s.missionResult!);
    expect(result.outcome).toBe("COMPLETED");
    expect(result.waypointsVisited).toBe(6);
    expect(result.falsePositives).toBe(0);

    // every capture the twin emitted reached the backend and came back analysed
    await lab.waitMission((s, n) => s.captures.length === n && s.captures.every((c) => c.status === "DONE"), result.captures, 90_000);
    const caps = await lab.mission((s) => s.captures.map((c) => ({ reason: c.request.reason, provider: c.result!.segmentations[0]?.provider, quality: c.result!.quality?.source })));
    expect(caps.every((c) => c.provider === "OFFLINE_FIXTURE" && c.quality === "IMAGE_DERIVED_ESTIMATE")).toBe(true);
    expect(caps.some((c) => c.reason === "REOBSERVE")).toBe(true);

    await lab.waitMission((s) => s.mission?.status === "COMPLETED" && s.report?.mission.id === s.mission.id, undefined, 30_000);
    await lab.scene(7);
    await expect(card.getByRole("heading", { name: /Inspection report/ })).toBeVisible();
    await expect(card.getByText(/Anomaly candidates \(unverified\)/)).toBeVisible();
    const report = await lab.mission((s) => s.report!);
    expect(report.anomalyCandidates.map((a) => a.label)).toContain("loose_cable");
    expect(report.summary.provider).toBe("TEMPLATE_FROM_RECORDS");
    await expect(card.getByText("TEMPLATE FROM RECORDS")).toBeVisible();
    await expect(lab.button(/export json/i)).toBeVisible();
    const download = page.waitForEvent("download");
    await lab.button(/export json/i).click();
    expect((await download).suggestedFilename()).toBe(`${m.id}.json`);
    // history lists the finished mission
    await expect(card.getByRole("button", { name: new RegExp(m.id) })).toBeVisible();
  });

  test("pause, refused resume in unsafe water, and stop are recorded", async ({ lab }) => {
    test.setTimeout(240_000);
    await lab.openOnline();
    await lab.scene(6);
    await lab.button(/^E Turbidity increase$/).click();
    await lab.planExample();
    await lab.button(/approve and run/i).click();
    await lab.waitFor((s) => s.mode === "MISSION");
    // scenario E pauses the scan on its own once the silt passes the unsafe limit
    await lab.fastForwardUntil((s) => s.mission?.status === "PAUSED", undefined, 60, 1);
    await lab.scene(5);
    await lab.button(/^resume$/i).click();
    await expect(lab.card().getByText(/Resume refused/)).toBeVisible();
    await lab.button(/stop mission/i).click();
    await lab.waitFor((s) => s.mode === "IDLE" && s.missionResult?.outcome === "STOPPED_UNSAFE_VISIBILITY");
    await lab.waitMission((s) => s.mission?.status === "ABORTED", undefined, 30_000);
    // the water goes back to what the operator set
    expect(await lab.state((s) => s.scenario.turbidity)).toBeCloseTo(0.15, 5);
  });

  test("the mission completes only after its last frame has landed, and a late frame refreshes the shown report", async ({ lab, page }) => {
    test.setTimeout(300_000);
    const order: string[] = [];
    page.on("response", (r) => r.url().endsWith("/api/inspection/capture") && order.push("frame"));
    page.on("request", (r) => r.url().endsWith("/complete") && order.push("complete"));
    await lab.openOnline();
    await lab.planExample();
    await lab.button(/approve and run/i).click();
    await lab.waitFor((s) => s.mode === "MISSION");
    // one long slice: every capture is emitted and the mission ends in the same instant, before the renderer has drawn a single frame
    await lab.fastForward(200);
    const result = await lab.state((s) => s.missionResult!);
    expect(result.captures).toBeGreaterThan(5);
    // the backend's own refresh (report.ready, after its summary) must be over, so only the store's reload can show a late frame
    await lab.waitMission((s) => s.mission?.status === "COMPLETED" && s.report?.mission.id === s.mission.id && !!s.report.summary, undefined, 60_000);
    // every frame was answered before the completion was posted, so the report holds all of them
    expect(order.indexOf("complete")).toBe(result.captures);
    expect(await lab.mission((s) => s.report!.path.length)).toBe(result.captures);

    // a frame that arrives after the mission closed (the wait gave up) is added to the report on screen
    await page.evaluate(async () => {
      const ms = window.__missionStore!.getState();
      const last = ms.captures[ms.captures.length - 1];
      const jpeg = await (await fetch(last.frameUrl)).blob();
      const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 480 });
      const png = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      await ms.submitCapture({ ...last.request, seq: last.request.seq + 1000 }, jpeg, png, []);
    });
    await lab.waitMission((s, n) => s.report!.path.length === n + 1, result.captures, 30_000);
  });
});
