import type { Page, Route } from "@playwright/test";
import type { Credits, ProviderStatus, SystemStatus } from "@/lib/api/types";
import { expect, test } from "./lab";

/**
 * Credit meter and live unlock. The default e2e backend has no key and no passcode, so the amber, exhausted, locked and unlock
 * states are served by a mock of /api/system/status and /api/system/unlock that behaves like the backend contract:
 * the status echoes whether this request carried the right passcode, and a wrong passcode counts as a failed attempt.
 */

const BACKEND = "http://localhost:8000";
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "Retry-After" };
const PASSCODE = "correct-horse-battery";
const CREDITS: Credits = { budgetUsd: 1, spentUsd: 0.042, remainingUsd: 0.958, liveCalls: 3, cachedCalls: 2, saved: { total: 9, byReason: { duplicate: 3, unusable_quality: 2, not_candidate: 1, cache_hit: 2, budget: 1 } } };
const REFUSED = /Failed to load resource: the server responded with a status of (403|429)/;

interface Mock {
  /** the X-Aqua-Passcode header of every API request the page made, in order (null when it sent none) */
  seen: (string | null)[];
  /** the same for /api/system/status alone, the one route polled on a timer */
  status: (string | null)[];
  urls: string[];
  /** the passcode the "backend" currently accepts; null: no lock */
  passcode: string | null;
  credits: Credits;
  keyed: boolean;
  /** failed unlock attempts allowed before 429 */
  attempts: number;
  retryAfter: number;
  /** how long to hold a status answer, by the passcode that request carried (to put reads out of order) */
  delay?: (sent: string | null) => number;
}

/** Serve status and unlock from a mock that follows the backend contract; everything else reaches the real backend. */
async function mockBackend(page: Page, init: Partial<Mock> = {}): Promise<Mock> {
  const base = (await (await page.request.get(`${BACKEND}/api/system/status`)).json()) as SystemStatus;
  const m: Mock = { seen: [], status: [], urls: [], passcode: PASSCODE, credits: CREDITS, keyed: true, attempts: 10, retryAfter: 60, ...init };
  page.on("request", (r) => {
    if (r.url().startsWith(BACKEND)) {
      m.urls.push(r.url());
      m.seen.push(r.headers()["x-aqua-passcode"] ?? null);
    }
  });
  await page.route("**/api/system/status", async (route: Route) => {
    const sent = route.request().headers()["x-aqua-passcode"] ?? null;
    m.status.push(sent);
    const unlocked = m.passcode === null || sent === m.passcode;
    const status: ProviderStatus["status"] = m.keyed ? (unlocked ? "LIVE" : "LIVE_LOCKED") : "OFFLINE";
    const p = (model: string) => ({ status, model, fallback: status === "LIVE" ? null : "OFFLINE_RULE_PARSER" });
    const body: SystemStatus = { ...base, providers: { spark: p("muse-spark"), sam: p("sam-3.1"), voice: p("voice") }, credits: m.credits, live: { lockEnabled: m.passcode !== null, unlocked } };
    const wait = m.delay?.(sent) ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return route.fulfill({ json: body, headers: CORS });
  });
  await page.route("**/api/system/unlock", (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const given = (route.request().postDataJSON() as { passcode: string }).passcode;
    if (m.attempts <= 0) return route.fulfill({ status: 429, json: { error: "too many passcode attempts; try again in a minute", unlocked: false }, headers: { ...CORS, "retry-after": String(m.retryAfter) } });
    const ok = given === m.passcode;
    if (!ok) m.attempts -= 1;
    return route.fulfill({ json: { unlocked: ok }, headers: CORS });
  });
  return m;
}

const chip = (page: Page) => page.getByTestId("chip-credits");
const ai = (page: Page) => page.getByTestId("chip-ai");
const stored = (page: Page) => page.evaluate(() => sessionStorage.getItem("aqua.passcode"));
const refresh = (page: Page) => page.evaluate(() => window.__missionStore!.getState().refreshStatus());

test.describe("credit meter", () => {
  test("the default backend has no key: the chip is grey and says so, the popover shows the counts and the honest note", async ({ lab, page }) => {
    await lab.openOnline();
    await expect(chip(page)).toHaveAttribute("data-state", "NO_KEY");
    await expect(page.getByTestId("credits-value")).toHaveText("NO KEY");
    await expect(chip(page)).toHaveAttribute("aria-label", /^Credits no key\./);
    await expect(ai(page)).toContainText("OFFLINE");
    expect(await ai(page).evaluate((el) => el.tagName)).toBe("SPAN"); // not a lock button: nothing to unlock

    await chip(page).click();
    const pop = page.getByTestId("credits-popover");
    await expect(pop).toBeVisible();
    await expect(page.getByTestId("credits-state")).toHaveText("NO KEY");
    await expect(pop).toContainText("No MODEL_API_KEY");
    await expect(pop).toContainText("Estimate from Meta list prices");
    await expect(pop.locator("[data-reason]")).toHaveCount(5);
    await expect(pop.getByText("Live calls", { exact: true })).toBeVisible();
    await expect(pop.getByText("Cached calls", { exact: true })).toBeVisible();
    await expect(chip(page)).toHaveAttribute("aria-expanded", "true");
  });

  test("within budget: the chip reads CREDITS $0.042 / $1.00 with a 4.2 percent bar, teal", async ({ lab, page }) => {
    await mockBackend(page, { passcode: null });
    await lab.openOnline();
    await expect(chip(page)).toHaveAttribute("data-state", "OK");
    await expect(chip(page)).toContainText(/credits/i);
    await expect(page.getByTestId("credits-value")).toHaveText("$0.042 / $1.00");
    await expect(chip(page)).toHaveAttribute("aria-label", /^Credits within budget\./);
    // the bar is 4.2 percent wide, not 4 and not 5: the exact style value, and the laid-out ratio to three places
    const bar = chip(page).locator("span[aria-hidden] > span");
    await expect(bar).toHaveAttribute("style", /^width:\s*4\.2%;?$/);
    await expect(async () => {
      const w = await bar.evaluate((el) => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width);
      expect(w).toBeCloseTo(0.042, 3);
    }).toPass();
    await expect(ai(page)).toContainText("META LIVE");
    expect(await ai(page).evaluate((el) => el.tagName)).toBe("SPAN"); // no lock configured, so no lock control
  });

  test("popover: counts, saved calls by reason, closes with Escape and returns focus, closes on an outside click", async ({ lab, page }) => {
    await mockBackend(page, { passcode: null });
    await lab.openOnline();
    await chip(page).focus();
    await page.keyboard.press("Enter");
    const pop = page.getByTestId("credits-popover");
    await expect(pop).toBeVisible();
    await expect(page.getByTestId("credits-state")).toHaveText("WITHIN BUDGET");
    await expect(page.getByTestId("credits-spent")).toHaveText("$0.0420");
    const row = (r: string) => pop.locator(`[data-reason=${r}]`);
    await expect(row("cache_hit")).toContainText("Identical request, cached answer");
    await expect(row("cache_hit")).toContainText("2");
    await expect(row("duplicate")).toContainText("3");
    await expect(row("unusable_quality")).toContainText("2");
    await expect(row("not_candidate")).toContainText("1");
    await expect(row("budget")).toContainText("1");
    await expect(pop.getByText("Estimate from Meta list prices")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await expect(chip(page)).toBeFocused();

    await chip(page).click();
    await expect(pop).toBeVisible();
    await page.mouse.click(700, 500);
    await expect(pop).toBeHidden();
  });

  test("amber above 80 percent, red when exhausted", async ({ lab, page }) => {
    const m = await mockBackend(page, { passcode: null, credits: { ...CREDITS, spentUsd: 0.85, remainingUsd: 0.15 } });
    await lab.openOnline();
    await expect(chip(page)).toHaveAttribute("data-state", "WARN");
    await expect(page.getByTestId("credits-value")).toHaveText("$0.850 / $1.00");
    await expect(page.getByTestId("credits-value")).toHaveCSS("color", "rgb(242, 180, 93)");
    await expect(chip(page).locator("span[aria-hidden] > span")).toHaveAttribute("style", /^width:\s*85%;?$/);
    await expect(chip(page)).toHaveAttribute("aria-label", /^Credits warning, over 80 percent\./);

    // exactly 80 percent is not above it
    m.credits = { ...CREDITS, spentUsd: 0.8, remainingUsd: 0.2 };
    await refresh(page);
    await expect(chip(page)).toHaveAttribute("data-state", "OK");

    m.credits = { ...CREDITS, spentUsd: 1.0004, remainingUsd: 0 };
    await refresh(page);
    await expect(chip(page)).toHaveAttribute("data-state", "EXHAUSTED");
    await expect(chip(page)).toHaveAttribute("aria-label", /^Credits cap reached\./);
    await expect(page.getByTestId("credits-value")).toHaveCSS("color", "rgb(241, 111, 112)");
    await chip(page).click();
    await expect(page.getByTestId("credits-state")).toHaveText("CAP REACHED");
    await expect(page.getByTestId("credits-popover")).toContainText("Budget cap reached");
  });

  test("the full CREDITS $0.042 / $1.00 text shows from 1280 px up and collapses to icon and amount below", async ({ lab, page }) => {
    await mockBackend(page, { passcode: null });
    await lab.openOnline();
    const label = chip(page).locator("span.label", { hasText: /^credits$/i });
    const budget = page.getByTestId("credits-value").locator("span");
    // the demo laptops: 1280, 1366, 1440, 1512, 1536, plus the wide displays
    for (const w of [1280, 1366, 1440, 1512, 1536, 1600, 1920, 2560]) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect(label, `${w}px label`).toBeVisible();
      await expect(budget, `${w}px budget`).toBeVisible();
      await expect(page.getByTestId("credits-value")).toHaveText("$0.042 / $1.00");
      expect(await headerProblems(page), `${w}px header`).toEqual([]);
    }
    await page.setViewportSize({ width: 1279, height: 900 });
    await expect(label).toBeHidden();
    await expect(budget).toBeHidden();
    await expect(page.getByTestId("credits-value")).toBeVisible(); // the amount stays
    expect(await headerProblems(page)).toEqual([]);
  });

  test("a spend below a tenth of a cent is not shown as zero", async ({ lab, page }) => {
    await mockBackend(page, { passcode: null, credits: { ...CREDITS, spentUsd: 0.00021, remainingUsd: 0.99979 } });
    await lab.openOnline();
    await expect(page.getByTestId("credits-value")).toHaveText("<$0.001 / $1.00");
  });

  test("an unreachable backend is unknown, never a number", async ({ lab, page, audit }) => {
    audit.allow.push(/localhost:8000/, /Failed to load resource/, /ERR_FAILED/, /WebSocket/i);
    await page.route("**/localhost:8000/**", (r) => r.abort());
    await lab.open();
    await expect(chip(page)).toHaveAttribute("data-state", "UNKNOWN");
    await expect(page.getByTestId("credits-value")).toHaveText("UNKNOWN");
    await expect(chip(page)).toHaveAttribute("aria-label", /^Credits unknown\./);
  });
});

test.describe("live unlock", () => {
  test("locked: the AI chip says LIVE LOCKED, opens the dialog, a wrong passcode is refused and forgotten", async ({ lab, page }) => {
    const m = await mockBackend(page);
    await lab.openOnline();
    await expect(ai(page)).toContainText("LIVE LOCKED");
    expect(await ai(page).evaluate((el) => el.tagName)).toBe("BUTTON");
    await ai(page).click();
    const dlg = page.getByTestId("unlock-dialog");
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole("textbox", { name: "Passcode" })).toBeFocused();
    await expect(dlg.getByRole("textbox", { name: "Passcode" })).toHaveAttribute("type", "password");

    await dlg.getByRole("textbox", { name: "Passcode" }).fill("not-it");
    await dlg.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.getByTestId("unlock-error")).toHaveText("That passcode was not accepted.");
    await expect(dlg.getByRole("textbox", { name: "Passcode" })).toHaveValue("");
    await expect(dlg.getByRole("textbox", { name: "Passcode" })).toBeFocused();
    expect(await stored(page)).toBeNull();
    await expect(ai(page)).toContainText("LIVE LOCKED");
    // nothing was ever sent as the header
    expect(m.seen.filter((h) => h !== null)).toEqual([]);
  });

  test("the right passcode unlocks: kept in sessionStorage only, sent as X-Aqua-Passcode, never in a URL or localStorage", async ({ lab, page }) => {
    const m = await mockBackend(page);
    await lab.openOnline();
    await ai(page).click();
    const dlg = page.getByTestId("unlock-dialog");
    await dlg.getByRole("textbox", { name: "Passcode" }).fill(PASSCODE);
    await dlg.getByRole("textbox", { name: "Passcode" }).press("Enter");
    await expect(dlg).toBeHidden();
    await expect(ai(page)).toContainText("META LIVE");
    expect(await stored(page)).toBe(PASSCODE);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(PASSCODE);
    expect(page.url()).not.toContain(PASSCODE);
    expect(m.urls.filter((u) => u.includes(PASSCODE) || u.includes("passcode"))).toEqual([]);

    // every later API request carries it (the poll, the evidence reads), and the unlock request itself did not carry an old one
    await refresh(page);
    await page.waitForTimeout(300);
    expect(m.seen.slice(-3).every((h) => h === PASSCODE)).toBe(true);
    // a reload of the tab keeps it
    await page.reload();
    await page.waitForFunction(() => window.__missionStore?.getState().system?.live.unlocked === true);
    await expect(ai(page)).toContainText("META LIVE");
  });

  test("keyboard: the chip opens the dialog, Tab stays inside, Escape closes and returns focus to the chip", async ({ lab, page }) => {
    await mockBackend(page);
    await lab.openOnline();
    await ai(page).focus();
    await page.keyboard.press("Enter");
    const dlg = page.getByTestId("unlock-dialog");
    await expect(dlg).toBeVisible();
    // passcode field, then Close, Cancel; Unlock is disabled until something is typed; focus wraps and never leaves the dialog
    const inside = () => page.evaluate(() => !!document.activeElement?.closest("[data-testid=unlock-dialog]"));
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await inside(), `tab ${i}`).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await inside()).toBe(true);
    // typing digits in the dialog must not change the scene behind it
    await dlg.getByRole("textbox", { name: "Passcode" }).fill("5");
    expect(await lab.state((s) => s.scene)).toBe(1);
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(ai(page)).toBeFocused();
  });

  test("too many failed attempts: the 429 and its Retry-After are shown, with a countdown, and submit is disabled until it ends", async ({ lab, page, audit }) => {
    audit.allow.push(REFUSED);
    await mockBackend(page, { attempts: 0, retryAfter: 3 });
    await lab.openOnline();
    await ai(page).click();
    const dlg = page.getByTestId("unlock-dialog");
    await dlg.getByRole("textbox", { name: "Passcode" }).fill("whatever");
    await dlg.getByRole("button", { name: "Unlock", exact: true }).click();
    const wait = page.getByTestId("unlock-wait");
    await expect(wait).toContainText(/Try again in [123] s/);
    await expect(wait).toContainText("Too many failed attempts");
    await dlg.getByRole("textbox", { name: "Passcode" }).fill("again");
    await expect(dlg.getByRole("button", { name: "Unlock", exact: true })).toBeDisabled();
    // the countdown ends and the form is usable again
    await expect(wait).toBeHidden({ timeout: 8000 });
    await expect(dlg.getByRole("button", { name: "Unlock", exact: true })).toBeEnabled();
    // the refusal is over, so its message goes with it
    await expect(page.getByTestId("unlock-error")).toHaveText("");
  });

  test("a stored passcode the backend rejects is forgotten at once and not sent again", async ({ lab, page }) => {
    const m = await mockBackend(page);
    await page.addInitScript((p) => sessionStorage.setItem("aqua.passcode", p), "old-passcode");
    await lab.openOnline();
    // the very first status read carried it, was told it is locked, and dropped it
    await expect(ai(page)).toContainText("LIVE LOCKED");
    expect(await stored(page)).toBeNull();
    // one failed attempt at load, however many reads were asked for at once (mount, socket open)
    expect(m.status.filter((h) => h === "old-passcode")).toHaveLength(1);
    const before = m.seen.length;
    await refresh(page);
    await refresh(page);
    await page.waitForTimeout(300);
    expect(m.seen.slice(before).filter((h) => h !== null)).toEqual([]);
    // the dialog says why
    await ai(page).click();
    await expect(page.getByTestId("unlock-notice")).toContainText("no longer works");
  });

  test("a passcode that stops working mid-session (rotated on the backend) is forgotten on the next status read", async ({ lab, page }) => {
    const m = await mockBackend(page);
    await lab.openOnline();
    await ai(page).click();
    await page.getByTestId("unlock-dialog").getByRole("textbox", { name: "Passcode" }).fill(PASSCODE);
    await page.keyboard.press("Enter");
    await expect(ai(page)).toContainText("META LIVE");
    m.passcode = "rotated-secret";
    await refresh(page);
    await expect(ai(page)).toContainText("LIVE LOCKED");
    expect(await stored(page)).toBeNull();
    const before = m.seen.length;
    await refresh(page);
    expect(m.seen.slice(before).filter((h) => h !== null)).toEqual([]);
  });

  test("a 403 live-mode-locked from a model route also forgets the passcode", async ({ lab, page, audit }) => {
    audit.allow.push(REFUSED);
    const m = await mockBackend(page);
    await page.addInitScript((p) => sessionStorage.setItem("aqua.passcode", p), PASSCODE);
    await page.route("**/api/voice/transcribe", (route) => route.fulfill({ status: 403, json: { error: "live mode locked" }, headers: CORS }));
    await lab.openOnline();
    await expect(ai(page)).toContainText("META LIVE");
    // the backend rotates, then a model route refuses before the next poll
    m.passcode = "rotated-secret";
    const r = await page.evaluate(() => window.__missionStore!.getState().transcribeRecorded());
    expect(r).toBeNull();
    expect(await stored(page)).toBeNull();
    await expect(ai(page)).toContainText("LIVE LOCKED"); // the store re-read the status without waiting for the poll
    await ai(page).click();
    await expect(page.getByTestId("unlock-notice")).toContainText("refused");
  });

  test("a 429 from a model route (Meta rate limiting) is not a verdict on the passcode", async ({ lab, page, audit }) => {
    audit.allow.push(REFUSED);
    await mockBackend(page);
    await page.addInitScript((p) => sessionStorage.setItem("aqua.passcode", p), PASSCODE);
    await page.route("**/api/voice/transcribe", (route) => route.fulfill({ status: 429, json: { error: "Muse Spark request failed: rate limited" }, headers: CORS }));
    await lab.openOnline();
    await page.evaluate(() => window.__missionStore!.getState().transcribeRecorded());
    expect(await stored(page)).toBe(PASSCODE);
    await expect(ai(page)).toContainText("META LIVE");
  });

  test("unlocked: the dialog offers to lock again, which forgets the passcode", async ({ lab, page }) => {
    const m = await mockBackend(page);
    await page.addInitScript((p) => sessionStorage.setItem("aqua.passcode", p), PASSCODE);
    await lab.openOnline();
    await expect(ai(page)).toContainText("META LIVE");
    await ai(page).click();
    const dlg = page.getByTestId("unlock-dialog");
    await expect(dlg).toContainText("Live mode is unlocked");
    await dlg.getByRole("button", { name: "Lock live mode" }).click();
    await expect(dlg).toBeHidden();
    expect(await stored(page)).toBeNull();
    await expect(ai(page)).toContainText("LIVE LOCKED");
    const before = m.seen.length;
    await refresh(page);
    expect(m.seen.slice(before).filter((h) => h !== null)).toEqual([]);
  });

  test("below 600 px the AI chip is gone: the credit chip shows the lock and its popover unlocks, with focus back on the chip", async ({ lab, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBackend(page);
    await lab.openOnline();
    await expect(ai(page)).toBeHidden();
    await expect(chip(page)).toHaveAttribute("aria-label", /Live mode is locked/);
    await expect(chip(page).locator("svg.lucide-lock")).toBeVisible();
    await chip(page).click();
    const row = page.getByTestId("credits-lock-row");
    await expect(row).toContainText("Live mode is locked");
    await row.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByTestId("credits-popover")).toBeHidden();
    const dlg = page.getByTestId("unlock-dialog");
    await expect(dlg).toBeVisible();
    await dlg.getByRole("textbox", { name: "Passcode" }).fill(PASSCODE);
    await page.keyboard.press("Enter");
    await expect(dlg).toBeHidden();
    await expect(chip(page).locator("svg.lucide-lock")).toBeHidden();
    expect(await stored(page)).toBe(PASSCODE);
  });

  test("at 600 px and up the lock row is not offered in the popover: the AI chip is the way in", async ({ lab, page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await mockBackend(page);
    await lab.openOnline();
    await expect(ai(page)).toBeVisible();
    await chip(page).click();
    await expect(page.getByTestId("credits-popover")).toBeVisible();
    await expect(page.getByTestId("credits-lock-row")).toBeHidden();
  });

  test("the lock row is in the popover wherever the AI chip is not drawn, so a locked or unlocked tab can always change state", async ({ lab, page }) => {
    const m = await mockBackend(page);
    await page.addInitScript((p) => sessionStorage.setItem("aqua.passcode", p), PASSCODE);
    await lab.openOnline();
    await expect(chip(page)).toHaveAttribute("data-state", "OK");
    const row = page.getByTestId("credits-lock-row");
    // unlocked: the header's secondary chips are drawn from 999 px up (they are hidden when narrower), so the popover offers the way back to locked below that
    for (const [w, drawn] of [[320, false], [599, false], [800, false], [998, false], [999, true], [1440, true]] as const) {
      await page.setViewportSize({ width: w, height: 900 });
      if (drawn) await expect(ai(page), `${w}px AI chip`).toBeVisible();
      else await expect(ai(page), `${w}px AI chip`).toBeHidden();
      await chip(page).click();
      if (drawn) await expect(row, `${w}px row`).toBeHidden();
      else await expect(row, `${w}px row`).toBeVisible();
      await page.keyboard.press("Escape");
    }
    // and it works at 800 px: Lock opens the dialog, Lock live mode forgets the passcode
    await page.setViewportSize({ width: 800, height: 900 });
    await chip(page).click();
    await expect(row).toContainText("Live mode is unlocked");
    await row.getByRole("button", { name: "Lock", exact: true }).click();
    const dlg = page.getByTestId("unlock-dialog");
    await expect(dlg).toContainText("Live mode is unlocked");
    await dlg.getByRole("button", { name: "Lock live mode" }).click();
    await expect(dlg).toBeHidden();
    expect(await stored(page)).toBeNull();
    await expect(chip(page).locator("svg.lucide-lock")).toBeHidden(); // below 600 only; at 800 the lock chip is the AI chip
    await expect(ai(page)).toContainText("LIVE LOCKED");
    const before = m.seen.length;
    await refresh(page);
    expect(m.seen.slice(before).filter((h) => h !== null)).toEqual([]);
    // locked at 800 px: the AI chip (icon only) is drawn, so no row
    await chip(page).click();
    await expect(row).toBeHidden();
  });

  test("a status read that began before an unlock cannot overwrite the unlocked state when it lands last", async ({ lab, page }) => {
    const m = await mockBackend(page);
    await lab.openOnline();
    await expect(ai(page)).toContainText("LIVE LOCKED");
    // a read without the passcode is held for 2.5 s; every read that carries one is instant
    m.delay = (sent) => (sent === null ? 2500 : 0);
    const slow = page.waitForResponse((r) => r.url().endsWith("/api/system/status") && r.request().headers()["x-aqua-passcode"] === undefined);
    await page.evaluate(() => void window.__missionStore!.getState().refreshStatus());
    await ai(page).click();
    await page.getByTestId("unlock-dialog").getByRole("textbox", { name: "Passcode" }).fill(PASSCODE);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("unlock-dialog")).toBeHidden();
    await expect(ai(page)).toContainText("META LIVE");
    // the stale answer ("locked") arrives now, after the newer one
    await slow;
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    expect(await lab.mission((s) => s.system?.live.unlocked)).toBe(true);
    await expect(ai(page)).toContainText("META LIVE");
    expect(await stored(page)).toBe(PASSCODE);
    // the same the other way round: a read that carried the passcode, landing after a re-lock, must not show unlocked
    m.delay = (sent) => (sent === PASSCODE ? 2500 : 0);
    const slowUnlocked = page.waitForResponse((r) => r.url().endsWith("/api/system/status") && r.request().headers()["x-aqua-passcode"] === PASSCODE);
    await page.evaluate(() => void window.__missionStore!.getState().refreshStatus());
    await page.evaluate(() => window.__missionStore!.getState().relock());
    await expect(ai(page)).toContainText("LIVE LOCKED");
    await slowUnlocked;
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    expect(await lab.mission((s) => s.system?.live.unlocked)).toBe(false);
    await expect(ai(page)).toContainText("LIVE LOCKED");
  });

  test("the system card labels a locked provider as locked, not offline", async ({ lab, page }) => {
    await mockBackend(page);
    await lab.openOnline();
    await lab.scene(2);
    const row = page.locator("[data-testid=system-health] [data-status]", { hasText: "Muse Spark 1.3" });
    await expect(row).toHaveAttribute("data-status", "LIVE_LOCKED");
    await expect(row).toContainText("LIVE LOCKED");
    await expect(row).toContainText("locked until the passcode is entered");
  });
});

/** Everything that can go wrong with the header at one width: overflow, a clipped left group, a control off screen or on top of another. */
const headerProblems = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const w = window.innerWidth;
    if (document.documentElement.scrollWidth > w) out.push(`page overflows by ${document.documentElement.scrollWidth - w}px`);
    const header = document.querySelector<HTMLElement>("[data-lab=header]")!;
    const left = header.firstElementChild as HTMLElement;
    if (left.scrollWidth > left.clientWidth + 1) out.push(`left group clipped by ${left.scrollWidth - left.clientWidth}px`);
    const brand = [...left.querySelectorAll("span")].find((e) => e.textContent === "AQUASENTINAL")!.getBoundingClientRect();
    if (brand.right > left.getBoundingClientRect().right + 0.5) out.push("brand clipped");
    const boxes = [...header.querySelectorAll<HTMLElement>("button, a, [data-testid^=chip-]")]
      .map((el) => ({ id: el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "?", r: el.getBoundingClientRect() }))
      .filter((b) => b.r.width > 0 && b.r.height > 0)
      .sort((a, b) => a.r.x - b.r.x);
    for (const b of boxes) {
      if (b.r.x < -0.5 || b.r.right > w + 0.5) out.push(`${b.id} outside the viewport`);
      if (b.r.bottom > 56) out.push(`${b.id} taller than the header`);
    }
    for (let i = 1; i < boxes.length; i++) if (boxes[i].r.x < boxes[i - 1].r.right - 0.5) out.push(`${boxes[i - 1].id} overlaps ${boxes[i].id}`);
    // the chips share one height
    const hs = new Set(boxes.filter((b) => b.id.startsWith("chip-")).map((b) => Math.round(b.r.height)));
    if (hs.size > 1) out.push(`chip heights differ: ${[...hs].join(", ")}`);
    return out;
  });

test.describe("header fit", () => {
  const STATES = {
    ok: { passcode: null },
    // a long amount and the widest AI chip text are the worst case for width
    locked: { credits: { ...CREDITS, spentUsd: 123.456, budgetUsd: 500, remainingUsd: 376.544 } },
    exhausted: { passcode: null, credits: { ...CREDITS, spentUsd: 1, remainingUsd: 0 } },
  } as const;

  for (const [name, init] of Object.entries(STATES)) {
    test(`${name}: from 320 to 2560 px the header never overflows, clips, overlaps or changes the chip height`, async ({ lab, page }) => {
      await page.setViewportSize({ width: 1440, height: 800 });
      await mockBackend(page, init as Partial<Mock>);
      await lab.openOnline();
      const bad: string[] = [];
      // every 20 px, plus the pixel either side of every breakpoint the header uses (a pair of show/hide classes that disagree by
      // one shows both or neither at exactly that width)
      const edges = [380, 440, 520, 600, 760, 1000, 1100, 1200, 1280, 1440, 1600].flatMap((n) => [n - 1, n, n + 1]);
      for (const w of [...Array.from({ length: 70 }, (_, i) => 320 + i * 20), ...edges, 1920, 2200, 2560]) {
        await page.setViewportSize({ width: w, height: 800 });
        await page.waitForTimeout(40);
        bad.push(...(await headerProblems(page)).map((p) => `${w}px: ${p}`));
      }
      expect(bad).toEqual([]);
    });
  }

  const WIDTHS = [
    [320, 568],
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1440, 900],
    [2560, 1440],
  ] as const;

  for (const [w, h] of WIDTHS) {
    for (const mode of ["ok", "locked", "exhausted"] as const) {
      test(`${w}x${h} ${mode}: the popover and the dialog stay on screen`, async ({ lab, page }) => {
        await page.setViewportSize({ width: w, height: h });
        await mockBackend(page, STATES[mode] as Partial<Mock>);
        await lab.openOnline();
        await expect(chip(page)).toHaveAttribute("data-state", mode === "exhausted" ? "EXHAUSTED" : "OK");
        const overflow = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth }));
        expect(await overflow()).toEqual({ doc: 0, body: 0 });
        expect(await headerProblems(page)).toEqual([]);

        await chip(page).click();
        const pop = (await page.getByTestId("credits-popover").boundingBox())!;
        expect(pop.x, "popover left").toBeGreaterThanOrEqual(0);
        expect(pop.x + pop.width, "popover right").toBeLessThanOrEqual(w + 0.5);
        expect(pop.y + pop.height, "popover bottom").toBeLessThanOrEqual(h);
        expect(await overflow()).toEqual({ doc: 0, body: 0 });
        await page.keyboard.press("Escape");

        if (mode === "locked") {
          if (w < 600) {
            // no AI chip here: the credit chip's popover carries the unlock button
            await chip(page).click();
            await page.getByTestId("credits-lock-row").getByRole("button", { name: "Unlock" }).click();
          } else await ai(page).click();
          const d = (await page.getByTestId("unlock-dialog").locator("form").boundingBox())!;
          expect(d.x).toBeGreaterThanOrEqual(0);
          expect(d.x + d.width).toBeLessThanOrEqual(w + 0.5);
          expect(d.y).toBeGreaterThanOrEqual(0);
          expect(d.y + d.height).toBeLessThanOrEqual(h);
          expect(await overflow()).toEqual({ doc: 0, body: 0 });
        }
      });
    }
  }
});
