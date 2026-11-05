import type { Page } from "@playwright/test";
import type { InspectionReport, InterpretResponse, MissionRecord, SystemStatus } from "@/lib/api/types";
import { expect, test } from "./lab";

/**
 * Operator language (EN | हिन्दी): the control, its persistence in this browser, the `language` field on the voice and planning
 * requests, and the "Hindi needs Meta models" label beside anything that did not come from a live Meta model. The default e2e
 * backend has no key, so live answers are served by route mocks that follow the backend contract.
 */

const BACKEND = "http://localhost:8000";
const CORS = { "access-control-allow-origin": "*" };
const KEY = "aqua.language";
const LABEL = "Hindi needs Meta models";
const EXPLANATION_HI = "पाइपलाइन को बाएँ से दाएँ स्कैन किया जाएगा।";
const RESULT = {
  adaptive: true, outcome: "COMPLETED", waypointsVisited: 6, waypointsPlanned: 6, captures: 0, unreliableCaptures: 0, reobservations: 0, pauses: 0,
  confirmedTargets: 0, falsePositives: 0, avgConfidence: 0, coverage: 1, minVisibility: 0.9, durationS: 20,
};

const control = (page: Page) => page.getByRole("radiogroup", { name: "Instruction language" });
const english = (page: Page) => control(page).getByRole("radio", { name: "EN" });
const hindi = (page: Page) => control(page).getByRole("radio", { name: "हिन्दी" });
const labels = (page: Page) => page.getByTestId("hindi-needs-meta");
const saved = (page: Page) => page.evaluate((k) => localStorage.getItem(k), KEY);
const chosen = (page: Page) => page.evaluate(() => window.__missionStore!.getState().language);

/** The `language` part of a multipart voice request. */
const formLanguage = (body: Buffer | null) => /name="language"\r\n\r\n(\w+)/.exec(body?.toString("latin1") ?? "")?.[1] ?? null;

/** Serve the status as if the backend had a key: every provider in `status`. */
async function mockProviders(page: Page, status: Partial<Record<"spark" | "sam" | "voice", "LIVE" | "OFFLINE" | "LIVE_LOCKED">>) {
  const base = (await (await page.request.get(`${BACKEND}/api/system/status`)).json()) as SystemStatus;
  await page.route("**/api/system/status", (route) => {
    const p = (k: "spark" | "sam" | "voice") => ({ ...base.providers[k], status: status[k] ?? "LIVE", fallback: status[k] === "LIVE" || !status[k] ? null : "OFFLINE_RULE_PARSER" });
    return route.fulfill({ json: { ...base, providers: { spark: p("spark"), sam: p("sam"), voice: p("voice") } }, headers: CORS });
  });
}

/** What the backend returns for a planned mission, read from a real (offline) plan so every field is genuine. */
async function realMission(page: Page, language: "en" | "hi", instruction = "inspect the pipeline from left to right for loose cables and foreign objects") {
  const res = await page.request.post(`${BACKEND}/api/ai/interpret`, { data: { instruction, language } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as InterpretResponse).mission;
}

/** The backend's report for a mission that has been planned, started and completed, with the template summary the offline path writes. */
async function finishedReport(page: Page, language: "en" | "hi") {
  const m = await realMission(page, language);
  await page.request.post(`${BACKEND}/api/missions/${m.id}/start`, { data: { executor: "TWIN" } });
  await page.request.post(`${BACKEND}/api/missions/${m.id}/complete`, { data: { ...RESULT, missionId: m.id } });
  await expect
    .poll(async () => ((await (await page.request.get(`${BACKEND}/api/inspection/${m.id}/report`)).json()) as InspectionReport).summary.provider, { timeout: 15_000 })
    .toBe("TEMPLATE_FROM_RECORDS");
  return m;
}

test.describe("operator language", () => {
  test("EN is the default, हिन्दी is one click or arrow key away, and the choice is remembered in this browser", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.scene(5);
    await expect(control(page)).toBeVisible();
    await expect(english(page)).toHaveAttribute("aria-checked", "true");
    await expect(hindi(page)).toHaveAttribute("aria-checked", "false");
    await expect(hindi(page)).toHaveAttribute("lang", "hi");
    expect(await saved(page)).toBeNull();

    await hindi(page).click();
    await expect(hindi(page)).toHaveAttribute("aria-checked", "true");
    expect(await chosen(page)).toBe("hi");
    expect(await saved(page)).toBe("hi");

    // a new visit to the page restores it
    await page.reload();
    await lab.open();
    expect(await chosen(page)).toBe("hi");
    await lab.scene(5);
    await expect(hindi(page)).toHaveAttribute("aria-checked", "true");

    // the radio group answers to the arrow keys like the other segmented controls
    await hindi(page).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(english(page)).toHaveAttribute("aria-checked", "true");
    await expect(english(page)).toBeFocused();
    expect(await saved(page)).toBe("en");
  });

  test("a saved value that is not a language is ignored", async ({ lab, page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, "klingon"), KEY);
    await lab.open();
    expect(await chosen(page)).toBe("en");
  });

  test("with storage blocked the page still renders and the choice holds for the session", async ({ lab, page }) => {
    // any touch of localStorage throws, as in some private windows; an uncaught error would fail the console audit
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
    });
    await lab.open();
    await lab.scene(5);
    await expect(english(page)).toHaveAttribute("aria-checked", "true");
    await hindi(page).click();
    await expect(hindi(page)).toHaveAttribute("aria-checked", "true");
    expect(await chosen(page)).toBe("hi");
    await lab.scene(6);
    await lab.scene(5);
    await expect(hindi(page)).toHaveAttribute("aria-checked", "true");
  });

  test("the language travels with the voice and planning requests", async ({ lab, page }) => {
    const voice: Array<string | null> = [];
    const plan: Array<unknown> = [];
    await page.route("**/api/voice/transcribe", (route) => {
      voice.push(formLanguage(route.request().postDataBuffer()));
      return route.fulfill({
        json: { transcript: "inspect the pipeline", provider: "MUSE_VOICE_TRANSCRIBE", model: "muse-voice", sessionId: "s", audioDurationMs: 1000, latencyMs: 120 },
        headers: CORS,
      });
    });
    await page.route("**/api/ai/interpret**", (route) => {
      plan.push((route.request().postDataJSON() as { language?: string }).language);
      return route.continue();
    });
    await lab.openOnline();
    await lab.scene(5);

    await page.evaluate(() => window.__missionStore!.getState().transcribeRecorded());
    expect(voice).toEqual(["en"]);
    await hindi(page).click();
    await page.evaluate(() => window.__missionStore!.getState().transcribeRecorded());
    expect(voice).toEqual(["en", "hi"]);

    // the transcript is now the instruction
    await lab.button(/plan mission/i).click();
    await lab.waitMission((m) => m.mission?.status === "PLANNED", undefined, 30_000);
    expect(plan).toEqual(["hi"]);
    expect(await lab.mission((s) => s.mission!.language)).toBe("hi");
  });

  test("offline output carries 'Hindi needs Meta models' while Hindi is selected, and not otherwise", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.planExample(); // no key: the labelled offline parser answers
    await expect(lab.card().getByText("OFFLINE FALLBACK").first()).toBeVisible();
    await expect(labels(page)).toHaveCount(0);

    await hindi(page).click();
    await expect(labels(page)).toHaveCount(2); // beside the instruction box and beside the offline plan
    await expect(labels(page).first()).toHaveText(LABEL);
    await expect(lab.card().getByText(/offline keyword parser/)).toBeVisible();
    await expect(lab.card().getByText(/offline keyword parser/)).not.toHaveAttribute("lang", "hi");

    await english(page).click();
    await expect(labels(page)).toHaveCount(0);
  });

  test("a live Hindi plan is shown as Hindi with no offline label", async ({ lab, page }) => {
    await mockProviders(page, {});
    const real = await realMission(page, "hi");
    const live: MissionRecord = { ...real, provider: "MUSE_SPARK", explanation: EXPLANATION_HI, warnings: [] };
    await page.route("**/api/ai/interpret**", (route) => route.fulfill({ json: { mission: live, provider: "MUSE_SPARK", model: "muse-spark-1.3" } satisfies InterpretResponse, headers: CORS }));
    await lab.openOnline();
    await lab.scene(5);
    await hindi(page).click();
    await expect(lab.card().getByText("MUSE SPARK 1.3").first()).toBeVisible();
    await page.getByRole("button", { name: /use the example instruction/i }).click();
    await lab.button(/plan mission/i).click();
    await lab.waitMission((m) => m.mission?.status === "PLANNED", undefined, 30_000);
    const text = lab.card().getByText(EXPLANATION_HI);
    await expect(text).toBeVisible();
    await expect(text).toHaveAttribute("lang", "hi");
    await expect(labels(page)).toHaveCount(0);
  });

  for (const [name, status] of [
    ["live mode locked", { spark: "LIVE_LOCKED", voice: "LIVE_LOCKED" }],
    ["no key", { spark: "OFFLINE", voice: "OFFLINE" }],
    ["Voice Transcribe not live", { voice: "OFFLINE" }],
  ] as const) {
    test(`Hindi is labelled as needing Meta models when ${name}`, async ({ lab, page }) => {
      await mockProviders(page, status);
      await lab.openOnline();
      await lab.scene(5);
      await expect(labels(page)).toHaveCount(0); // English needs nothing from the models
      await hindi(page).click();
      await expect(labels(page)).toHaveCount(1);
      await expect(labels(page)).toHaveText(LABEL);
    });
  }

  test("the label is absent while both Spark and Voice are live", async ({ lab, page }) => {
    await mockProviders(page, {});
    await lab.openOnline();
    await lab.scene(5);
    await hindi(page).click();
    await expect(lab.card().getByText("MUSE SPARK 1.3").first()).toBeVisible();
    await expect(labels(page)).toHaveCount(0);
  });

  test("a template summary is labelled, a Meta summary in Hindi is not", async ({ lab, page }) => {
    const m = await finishedReport(page, "hi");
    await lab.openOnline();
    await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), m.id);
    await lab.waitMission((s) => s.report?.mission.language === "hi");
    await lab.scene(7);
    const card = lab.card();
    await expect(card.getByText("TEMPLATE FROM RECORDS")).toBeVisible();
    await expect(labels(page)).toHaveCount(0); // English is selected

    await lab.scene(5);
    await hindi(page).click();
    await lab.scene(7);
    await expect(card.getByText("TEMPLATE FROM RECORDS")).toBeVisible();
    await expect(labels(page)).toHaveCount(1);

    // the same report as Muse Spark would write it: Hindi text, marked as Hindi, no label
    await page.route(`**/api/inspection/${m.id}/report`, async (route) => {
      const report = (await (await route.fetch()).json()) as InspectionReport;
      const summary = { ...report.summary, provider: "MUSE_SPARK", model: "muse-spark-1.3", summary: "सारांश: एक ढीली केबल मिली।", limitations: ["केवल एक कैप्चर"] };
      await route.fulfill({ json: { ...report, summary }, headers: CORS });
    });
    await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), m.id);
    await expect(card.getByText("सारांश: एक ढीली केबल मिली।")).toHaveAttribute("lang", "hi");
    await expect(card.getByText("केवल एक कैप्चर")).toBeVisible();
    await expect(labels(page)).toHaveCount(0);
  });

  for (const [w, h] of [
    [320, 568],
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`${w}x${h}: the control and the label fit with Hindi selected`, async ({ lab, page }) => {
      await page.setViewportSize({ width: w, height: h });
      await lab.openOnline();
      await lab.scene(5);
      await hindi(page).click();
      await expect(labels(page)).toHaveCount(1);
      for (const box of [await control(page).boundingBox(), await labels(page).boundingBox()]) {
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(w + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      // reachable without leaving the card: the card scrolls inside itself, the page does not
      await control(page).scrollIntoViewIfNeeded();
      await expect(control(page)).toBeInViewport();
    });
  }
});
