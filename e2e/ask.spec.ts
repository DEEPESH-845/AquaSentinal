import type { Page } from "@playwright/test";
import type { AskResponse } from "@/lib/api/types";
import { expect, test, type Lab } from "./lab";
import { BACKEND, CORS, mockProviders, seedMission, trackedAt } from "./seed";

/**
 * Ask the inspector (scene 07, under the report). The e2e backend has no key, so the offline records query answers for real from a
 * mission stored in the backend; a live Muse Spark answer is served by a route mock that follows the backend contract
 * (the tool loop itself is covered by backend/tests/test_ask.py).
 */

// a fake microphone, so push-to-talk really records in the voice test; Voice Transcribe itself is answered by a route mock
test.use({
  permissions: ["microphone"],
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

/** Opens the app, seeds a mission, shows its report in scene 07 and waits for the panel. */
async function openReport(lab: Lab, page: Page) {
  await lab.openOnline();
  const mission = await seedMission(page);
  await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), mission.id);
  await lab.waitMission((s, id) => s.report?.mission.id === id && s.report.assets.length === 2, mission.id, 15_000);
  await lab.scene(7);
  await expect(page.getByTestId("ask-panel")).toBeVisible();
  return mission;
}

const panel = (page: Page) => page.getByTestId("ask-panel");
const answers = (page: Page) => page.getByTestId("ask-answer");
const input = (page: Page) => page.getByLabel("Question about this mission");

/** A Muse Spark answer shaped like the backend's, citing the real captures of the seeded mission. */
function liveAnswer(captureIds: string[], patch: Partial<AskResponse> = {}): AskResponse {
  return {
    answer: "The loose cable lies at (66.0, 30.0) cm [1]. It is an unverified anomaly candidate, and the wrench is near the far corner [2].",
    citations: [
      { captureId: captureIds[0], x: 66, y: 30, label: "loose_cable" },
      { captureId: captureIds[1], x: 85, y: 9, label: "foreign_object" },
    ],
    toolCalls: [
      { name: "list_observations", arguments: {}, ok: true, result: {}, error: null, phase: "ASK", by: "MUSE_SPARK", at: 1 },
      { name: "get_track", arguments: { track_id: "asset_x" }, ok: true, result: {}, error: null, phase: "ASK", by: "MUSE_SPARK", at: 2 },
    ],
    provider: "MUSE_SPARK",
    model: "muse-spark-1.3",
    executionIds: ["exe_aaaaaaaaaaaa", "exe_bbbbbbbbbbbb", "exe_cccccccccccc"],
    classification: "LIVE_META",
    fallback: null,
    note: "",
    droppedCitations: ["cap_deadbeef0001"],
    language: "en",
    ...patch,
  };
}

test.describe("Ask the inspector", () => {
  test("offline: the records query answers from the stored mission, labelled, with citations that open in the twin", async ({ lab, page }) => {
    const mission = await openReport(lab, page);

    // the panel belongs to the report scene and says before any question who will answer: no key, so the records query
    await expect(panel(page).getByRole("heading", { name: "Ask the inspector" })).toBeVisible();
    await expect(page.getByTestId("ask-answerer")).toHaveText("OFFLINE RECORDS QUERY");
    await expect(page.getByTestId("ask-answerer")).toHaveAttribute("data-status", "OFFLINE");
    await expect(panel(page).getByTestId("ask-suggestion")).toHaveText(["Where is the loose cable?", "How many objects were found?", "How confident is the detection?"]);
    await expect(panel(page).getByRole("button", { name: /hold to talk/i })).toBeDisabled();
    await expect(panel(page).getByRole("button", { name: /hold to talk/i })).toHaveAttribute("title", /needs MODEL_API_KEY.*Type the question instead/);

    // a suggested question is one click; the answer comes from the stored records, not a model
    await panel(page).getByTestId("ask-suggestion").first().click();
    const first = answers(page).first();
    await expect(first).toHaveAttribute("data-provider", "OFFLINE_RECORDS_QUERY");
    await expect(first).toHaveAttribute("data-fallback", "NO_KEY");
    const cable = await trackedAt(page, "loose_cable"); // where the report tracks it; earlier specs' sightings can move it a fraction of a centimetre
    await expect(first.getByTestId("ask-answer-text")).toContainText(new RegExp(`Loose cable \\w{6} is at ${cable.replace(/[().]/g, "\\$&")}, observed 1 time\\(s\\) \\[1\\]\\.`));
    await expect(first.getByTestId("ask-badges")).toHaveText("OFFLINE RECORDS QUERY");
    await expect(first).not.toContainText("cap_");
    await expect(first).toContainText("tools: list_observations, get_track");
    await expect(first).not.toContainText("Meta request");

    // the citation has the stored frame as its thumbnail, loaded from the backend
    const chip = first.getByTestId("ask-citation");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("data-capture", mission.captureIds[0]);
    await expect(chip).toContainText("loose cable");
    await expect(chip).toContainText(cable.replace(" cm", ""));
    await expect.poll(() => chip.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(chip.locator("img")).toHaveAttribute("src", `${BACKEND}/api/inspection/frames/${mission.captureIds[0]}`);

    // clicking it selects the cable in the twin and sends the carriage and the follow camera to it
    expect(await lab.state((s) => s.selectedObjectId)).not.toBe("cable-1");
    await chip.click();
    await lab.waitFor((s) => s.selectedObjectId === "cable-1" && s.cameraPreset === "D");
    // (tracking refines the coarse position with the detector's own estimate, so the target is near the cable, not exactly on it)
    const [tx, ty] = await lab.state((s) => [s.engine.gantry.x.target, s.engine.gantry.y.target]);
    expect(Math.hypot(tx - 66, ty - 30)).toBeLessThan(2);

    // typed questions, newest first; the other intents
    await input(page).fill("How many objects were found?");
    await input(page).press("Enter");
    await expect(answers(page).first().getByTestId("ask-answer-text")).toContainText("2 tracked object(s) from 2 observation(s) in 2 capture(s): 1 loose cable, 1 foreign object");
    await expect(answers(page).first().getByTestId("ask-citation")).toHaveCount(2);
    await expect(answers(page)).toHaveCount(2);
    await expect(answers(page).nth(1)).toContainText("Loose cable");
    await expect(input(page)).toHaveValue("");

    await panel(page).getByTestId("ask-suggestion").nth(2).click();
    await expect(answers(page).first().getByTestId("ask-answer-text")).toContainText("best confidence 80 percent from the simulated detector (the twin's own score, not a model's)");

    // anything else is said to need the Meta models: no invented answer, no citations
    await input(page).fill("Why is the water so cloudy today?");
    await input(page).press("Enter");
    await expect(answers(page).first().getByTestId("ask-answer-text")).toContainText("Free-form questions need Meta models.");
    await expect(answers(page).first().getByTestId("ask-citation")).toHaveCount(0);

    // a question is not sent twice, and a too-short one is not sent at all
    await input(page).fill("hi");
    await expect(panel(page).getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
  });

  test("offline answers stay English in Hindi, and say that Hindi needs the Meta models", async ({ lab, page }) => {
    await openReport(lab, page);
    const bodies: Array<{ question: string; language: string }> = [];
    await page.route("**/api/inspection/*/ask", (route) => {
      bodies.push(route.request().postDataJSON());
      return route.continue();
    });
    const labels = panel(page).getByTestId("hindi-needs-meta"); // the report's own summary above has a label of its own
    await expect(labels).toHaveCount(0);
    await panel(page).getByRole("radio", { name: "हिन्दी" }).click();
    await expect(labels).toHaveCount(1); // beside the language control
    await panel(page).getByTestId("ask-suggestion").first().click();
    await expect(answers(page).first().getByTestId("ask-answer-text")).toContainText("Loose cable");
    expect(bodies).toEqual([{ question: "Where is the loose cable?", language: "hi" }]);
    await expect(labels).toHaveCount(2); // and beside the offline answer
    await expect(answers(page).first().getByTestId("ask-answer-text")).not.toHaveAttribute("lang", "hi");
  });

  test("a live Muse Spark answer shows its provenance, numbered claims, citations and the logged requests", async ({ lab, page }) => {
    await mockProviders(page, "LIVE");
    const asked: unknown[] = [];
    await lab.openOnline();
    const mission = await seedMission(page);
    await page.route("**/api/inspection/*/ask", (route) => {
      asked.push(route.request().postDataJSON());
      return route.fulfill({ json: liveAnswer(mission.captureIds), headers: CORS });
    });
    await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), mission.id);
    await lab.waitMission((s, id) => s.report?.mission.id === id, mission.id, 15_000);
    await lab.scene(7);
    await expect(page.getByTestId("ask-answerer")).toHaveText("MUSE SPARK 1.3 + TOOLS");
    await expect(page.getByTestId("ask-answerer")).toHaveAttribute("data-status", "LIVE");
    await expect(panel(page).getByRole("button", { name: /hold to talk/i })).toBeEnabled();

    await input(page).fill("Where are the cable and the wrench?");
    await panel(page).getByRole("button", { name: "Ask", exact: true }).click();
    expect(asked).toEqual([{ question: "Where are the cable and the wrench?", language: "en" }]);
    const a = answers(page).first();
    await expect(a).toHaveAttribute("data-provider", "MUSE_SPARK");
    await expect(a.getByTestId("ask-answer-text")).toContainText("The loose cable lies at (66.0, 30.0) cm [1]. It is an unverified anomaly candidate, and the wrench is near the far corner [2].");
    await expect(a.getByTestId("ask-badges")).toContainText("MUSE SPARK 1.3");
    await expect(a.getByTestId("ask-badges").locator("[data-exec]")).toHaveAttribute("data-exec", "LIVE_META");
    await expect(a.getByTestId("ask-badges")).not.toContainText("OFFLINE");
    await expect(a).toContainText("tools: list_observations, get_track / 3 Meta requests logged / 1 uncited id dropped");
    await expect(panel(page).getByTestId("hindi-needs-meta")).toHaveCount(0);
    await expect(a.getByTestId("ask-answer-text")).not.toHaveAttribute("lang", "hi");

    // the reveal is animation only: afterwards nothing is left transparent
    await expect.poll(() => a.getByTestId("ask-answer-text").locator(".opacity-0").evaluateAll((els) => els.map((e) => e.textContent).join(""))).toBe("");

    // two citations, in the order of the markers; each moves the selection to its own object
    const chips = a.getByTestId("ask-citation");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute("data-capture", mission.captureIds[0]);
    await expect(chips.nth(1)).toHaveAttribute("data-capture", mission.captureIds[1]);
    await chips.nth(1).click();
    await lab.waitFor((s) => s.selectedObjectId === "wrench-1" && s.cameraPreset === "D");
    await chips.nth(0).click();
    await lab.waitFor((s) => s.selectedObjectId === "cable-1" && Math.hypot(s.engine.gantry.x.target - 66, s.engine.gantry.y.target - 30) < 2);
  });

  test("a cached answer says CACHED LIVE, a mocked one MOCKED, and a Hindi answer is marked as Hindi", async ({ lab, page }) => {
    await mockProviders(page, "LIVE");
    await lab.openOnline();
    const mission = await seedMission(page);
    const next: AskResponse[] = [
      liveAnswer(mission.captureIds, { classification: "CACHED_LIVE" }),
      liveAnswer(mission.captureIds, { classification: "MOCKED" }),
      liveAnswer(mission.captureIds, { answer: "केबल (66.0, 30.0) सेमी पर है [1]।", language: "hi", citations: [liveAnswer(mission.captureIds).citations[0]], droppedCitations: [] }),
    ];
    await page.route("**/api/inspection/*/ask", (route) => route.fulfill({ json: next.shift(), headers: CORS }));
    await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), mission.id);
    await lab.waitMission((s, id) => s.report?.mission.id === id, mission.id, 15_000);
    await lab.scene(7);

    await panel(page).getByTestId("ask-suggestion").nth(0).click();
    await expect(answers(page).first().getByTestId("ask-badges").locator("[data-exec]")).toHaveAttribute("data-exec", "CACHED_LIVE");
    await expect(answers(page).first().getByTestId("ask-badges")).toContainText("CACHED LIVE");
    await panel(page).getByTestId("ask-suggestion").nth(1).click();
    await expect(answers(page).first().getByTestId("ask-badges").locator("[data-exec]")).toHaveAttribute("data-exec", "MOCKED");

    await panel(page).getByRole("radio", { name: "हिन्दी" }).click();
    await panel(page).getByTestId("ask-suggestion").nth(2).click();
    const hindi = answers(page).first().getByTestId("ask-answer-text");
    await expect(hindi).toContainText("केबल (66.0, 30.0) सेमी पर है [1]।");
    await expect(hindi).toHaveAttribute("lang", "hi");
    await expect(panel(page).getByTestId("hindi-needs-meta")).toHaveCount(0); // live Hindi needs nothing more
  });

  test("a locked backend answers from the records and reads as locked, not offline; a budget refusal says so", async ({ lab, page }) => {
    await mockProviders(page, "LIVE_LOCKED");
    await lab.openOnline();
    const mission = await seedMission(page);
    const locked = liveAnswer(mission.captureIds, {
      answer: "Loose cable ab12cd is at (66.0, 30.0) cm, observed 1 time(s)[1].",
      citations: [liveAnswer(mission.captureIds).citations[0]],
      toolCalls: [],
      provider: "OFFLINE_RECORDS_QUERY",
      model: null,
      executionIds: [],
      classification: null,
      fallback: "LIVE_LOCKED",
      note: "Live mode is locked: the offline records query answered, not Muse Spark.",
      droppedCitations: [],
    });
    const next: AskResponse[] = [locked, { ...locked, fallback: "BUDGET_EXCEEDED", note: "The Meta credit budget would be exceeded: the offline records query answered, not Muse Spark." }];
    await page.route("**/api/inspection/*/ask", (route) => route.fulfill({ json: next.shift(), headers: CORS }));
    await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), mission.id);
    await lab.waitMission((s, id) => s.report?.mission.id === id, mission.id, 15_000);
    await lab.scene(7);
    await expect(page.getByTestId("ask-answerer")).toHaveText("LIVE LOCKED");
    await expect(page.getByTestId("ask-answerer")).toHaveAttribute("data-status", "LIVE_LOCKED");
    await expect(panel(page).getByRole("button", { name: /hold to talk/i })).toHaveAttribute("title", /locked/);

    await panel(page).getByTestId("ask-suggestion").first().click();
    const a = answers(page).first();
    await expect(a).toHaveAttribute("data-fallback", "LIVE_LOCKED");
    await expect(a.getByTestId("ask-badges")).toContainText("LIVE LOCKED");
    await expect(a.getByTestId("ask-badges")).toContainText("RECORDS QUERY");
    await expect(a.getByTestId("ask-badges")).not.toContainText("OFFLINE");
    await expect(a).toContainText("Live mode is locked");
    await expect(a).toContainText("no tools called");

    await panel(page).getByTestId("ask-suggestion").nth(1).click();
    await expect(answers(page).first().getByTestId("ask-badges")).toContainText("OFFLINE RECORDS QUERY");
    await expect(answers(page).first().getByTestId("ask-badges")).toContainText("BUDGET REACHED");
  });

  test("a failed request is shown, and the question goes back in the box", async ({ lab, page, audit }) => {
    audit.allow.push(/status of 500/); // the browser logs the refused request itself
    await page.route("**/api/inspection/*/ask", (route) => route.fulfill({ status: 500, json: { error: "boom" }, headers: CORS }));
    await openReport(lab, page);
    await input(page).fill("Where is the loose cable?");
    await input(page).press("Enter");
    const a = answers(page).first();
    await expect(a).toHaveAttribute("data-status", "FAILED");
    await expect(a).toContainText("boom");
    await expect(input(page)).toHaveValue("Where is the loose cable?");
  });

  test("an unknown capture gets no thumbnail and no broken image", async ({ lab, page }) => {
    await mockProviders(page, "LIVE");
    await lab.openOnline();
    const mission = await seedMission(page);
    const reply = liveAnswer(mission.captureIds, { citations: [{ captureId: "cap_000000000000", x: 12, y: 8, label: "inspection_panel" }], answer: "A panel sits at (12.0, 8.0) cm [1].", droppedCitations: [] });
    await page.route("**/api/inspection/*/ask", (route) => route.fulfill({ json: reply, headers: CORS }));
    await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), mission.id);
    await lab.waitMission((s, id) => s.report?.mission.id === id, mission.id, 15_000);
    await lab.scene(7);
    await input(page).fill("Where is the panel?");
    await input(page).press("Enter");
    const chip = answers(page).first().getByTestId("ask-citation");
    await expect(chip).toContainText("inspection panel");
    await expect(chip.locator("img")).toHaveCount(0);
    await chip.click();
    await lab.waitFor((s) => s.selectedObjectId === "panel-1" && s.cameraPreset === "D");
  });

  test("keyboard: Tab reaches the suggestions and each citation, the focus ring shows, and Enter opens a citation in the twin", async ({ lab, page }) => {
    await openReport(lab, page);
    await panel(page).getByTestId("ask-suggestion").first().click();
    await expect(answers(page).first().getByTestId("ask-citation")).toHaveCount(1);
    await input(page).focus();
    await expect(input(page)).toBeFocused();
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("Tab");
      seen.push(await page.evaluate(() => (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.textContent ?? "").trim().slice(0, 40)));
    }
    // (the voice button and Ask are disabled here: no key, nothing typed)
    expect(seen.filter((s) => s === "ask-suggestion")).toHaveLength(3);
    expect(seen.some((s) => s.startsWith("Citation 1"))).toBe(true);
    // the focused citation shows the focus ring and Enter opens it in the twin
    await page.getByTestId("ask-citation").focus();
    await expect(page.getByTestId("ask-citation")).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe("solid");
    await page.keyboard.press("Enter");
    await lab.waitFor((s) => s.selectedObjectId === "cable-1");
  });

  test("layout: the panel fits from 320 to 2560 px without horizontal scroll", async ({ lab, page }) => {
    await openReport(lab, page);
    await panel(page).getByTestId("ask-suggestion").nth(1).click();
    await expect(answers(page).first().getByTestId("ask-citation")).toHaveCount(2);
    for (const [w, h] of [[320, 568], [390, 844], [768, 1024], [1280, 720], [1440, 900], [2560, 1440]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await panel(page).scrollIntoViewIfNeeded();
      const fit = await page.evaluate(() => {
        const p = document.querySelector("[data-testid=ask-panel]")!.getBoundingClientRect();
        const card = document.querySelector("[data-lab=card] > div")!.getBoundingClientRect();
        const wide = [...document.querySelectorAll("[data-testid=ask-panel] *")].filter((e) => e.getBoundingClientRect().right > p.right + 1 && getComputedStyle(e).position !== "absolute").length;
        return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide, inCard: p.right <= card.right + 1 && p.left >= card.left - 1 };
      });
      expect(fit, `${w}x${h}`).toEqual({ page: 0, wide: 0, inCard: true });
    }
  });
});

test.describe("Ask the inspector by voice", () => {
  // (the fake microphone is set up at the top of the file)
  test("push-to-talk fills the question box, not the mission instruction", async ({ lab, page }) => {
    await mockProviders(page, "LIVE");
    const forms: string[] = [];
    await page.route("**/api/voice/transcribe", (route) => {
      forms.push(route.request().postDataBuffer()?.toString("latin1") ?? "");
      return route.fulfill({
        json: { transcript: "where is the loose cable", provider: "MUSE_VOICE_TRANSCRIBE", model: "muse-voice", sessionId: "s", audioDurationMs: 800, latencyMs: 90 },
        headers: CORS,
      });
    });
    await lab.openOnline();
    const mission = await seedMission(page);
    await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), mission.id);
    await lab.waitMission((s, id) => s.report?.mission.id === id, mission.id, 15_000);
    await lab.scene(7);
    const talk = panel(page).getByRole("button", { name: /hold to talk/i });
    await expect(talk).toBeEnabled();
    const box = (await talk.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await lab.waitMission((s) => s.voice.state === "RECORDING");
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(input(page)).toHaveValue("where is the loose cable");
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatch(/name="inputSource"\r\n\r\nLIVE_MICROPHONE/);
    expect(forms[0]).toMatch(/name="language"\r\n\r\nen/);
    // the spoken question is not the mission's voice instruction: the agent chain's voice step stays empty
    expect(await lab.mission((s) => [s.instruction, s.transcript, s.askDraft])).toEqual(["", null, "where is the loose cable"]);
  });
});

