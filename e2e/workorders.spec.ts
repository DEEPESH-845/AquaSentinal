import type { Page } from "@playwright/test";
import type { WorkOrder, WorkOrdersResponse } from "@/lib/api/types";
import { expect, test, type Lab } from "./lab";
import { BACKEND, CORS, mockProviders, seedMission } from "./seed";

/**
 * Work orders (scene 07, in the report above Ask the inspector). The e2e backend has no key, so the offline rule table writes the orders for
 * real from a mission stored in the backend; a live Muse Spark list is served by a route mock that follows the backend contract
 * (the structured-output call, grounding checks, cache, lock and budget are covered by backend/tests/test_workorders.py).
 */

const panel = (page: Page) => page.getByTestId("workorders-panel");
const cards = (page: Page) => page.getByTestId("workorder");
const generate = (page: Page) => page.getByTestId("workorders-generate");
const printButton = (page: Page) => page.getByTestId("workorders-print-button");

/** Counts window.print() instead of opening a dialog the test cannot dismiss. */
async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => void ((window as unknown as { __prints: number }).__prints += 1);
  });
}
const prints = (page: Page) => page.evaluate(() => (window as unknown as { __prints: number }).__prints);

async function showReport(lab: Lab, page: Page, mission: { id: string }) {
  await page.evaluate((id) => window.__missionStore!.getState().loadReport(id), mission.id);
  await lab.waitMission((s, id) => s.report?.mission.id === id && s.report.assets.length === 2, mission.id, 15_000);
  await lab.scene(7);
  await expect(panel(page)).toBeVisible();
}

/** A Muse Spark list shaped like the backend's, citing the real captures of the seeded mission. */
function liveList(captureIds: string[], patch: Partial<WorkOrdersResponse> = {}): WorkOrdersResponse {
  const orders: WorkOrder[] = [
    { id: "WO-01", priority: "P1", title: "Re-route the loose cable", location: { x: 66, y: 30 }, evidence: [captureIds[0]], action: "Verify the cable, then secure it clear of the pipeline.", effort: "M", rationale: "Seen once beside the pipeline; an unverified candidate." },
    { id: "WO-02", priority: "P3", title: "Fetch the dropped wrench", location: { x: 85, y: 9 }, evidence: [captureIds[1]], action: "Retrieve the wrench from the far corner.", effort: "S", rationale: "Seen once near the tank wall." },
  ];
  return {
    orders, provider: "MUSE_SPARK", model: "muse-spark-1.3", executionIds: ["exe_aaaaaaaaaaaa"], classification: "LIVE_META", fallback: null, note: "", droppedEvidence: ["cap_deadbeef0001"], droppedOrders: 1, language: "en", ...patch,
  };
}

test.describe("Work orders", () => {
  test("offline: one click writes the orders from the rule table, labelled, with the evidence frames", async ({ lab, page }) => {
    await lab.openOnline();
    const mission = await seedMission(page);
    const asked: unknown[] = [];
    await page.route("**/api/inspection/*/work-orders", (route) => {
      asked.push(route.request().postDataJSON());
      return route.continue();
    });
    await showReport(lab, page, mission);

    // the panel belongs to the report, says who will write before anything is asked, and nothing is printable yet
    await expect(panel(page).getByRole("heading", { name: "Work orders" })).toBeVisible();
    await expect(page.getByTestId("workorders-writer")).toHaveText("OFFLINE RULES");
    await expect(page.getByTestId("workorders-writer")).toHaveAttribute("data-status", "OFFLINE");
    await expect(cards(page)).toHaveCount(0);
    await expect(printButton(page)).toBeDisabled();
    await expect(page.getByTestId("workorders-print")).toHaveCount(0);

    await generate(page).click();
    await expect(cards(page)).toHaveCount(2);
    expect(asked).toEqual([{ language: "en" }]);
    await expect(panel(page)).toHaveAttribute("data-provider", "OFFLINE_RULES");
    await expect(page.getByTestId("workorders-badges")).toHaveText("OFFLINE RULES");

    const [cable, foreign] = [cards(page).nth(0), cards(page).nth(1)];
    await expect(cable).toHaveAttribute("data-priority", "P1");
    await expect(cable).toHaveAttribute("data-id", "WO-01");
    await expect(cable).toContainText("Secure and re-route the loose cable");
    await expect(cable).toContainText("(66.0, 30.0) cm");
    await expect(cable).toContainText("effort M");
    await expect(cable).toContainText("unverified anomaly candidate");
    await expect(foreign).toHaveAttribute("data-priority", "P2");
    await expect(foreign).toContainText("Remove the foreign object");
    await expect(foreign).toContainText("(85.0, 9.0) cm");

    // each order shows the stored frame it rests on, loaded from the backend
    for (const [card, captureId] of [[cable, mission.captureIds[0]], [foreign, mission.captureIds[1]]] as const) {
      const ev = card.getByTestId("workorder-evidence");
      await expect(ev).toHaveAttribute("data-capture", captureId);
      await expect.poll(() => ev.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      await expect(ev.locator("img")).toHaveAttribute("src", `${BACKEND}/api/inspection/frames/${captureId}`);
    }

    // the priority colours differ, so a P1 never reads like a routine check
    const edge = (i: number) => cards(page).nth(i).evaluate((el) => getComputedStyle(el).borderLeftColor);
    expect(await edge(0)).not.toBe(await edge(1));
    await expect(printButton(page)).toBeEnabled();
  });

  test("print: the button calls window.print and the print rules leave one clean page per order", async ({ lab, page }) => {
    await stubPrint(page);
    await lab.openOnline();
    const mission = await seedMission(page);
    await showReport(lab, page, mission);
    await expect(printButton(page)).toBeDisabled();
    await generate(page).click();
    await expect(cards(page)).toHaveCount(2);

    expect(await prints(page)).toBe(0);
    await expect(printButton(page)).toHaveText(/Print work orders/);
    await printButton(page).click();
    expect(await prints(page)).toBe(1);

    // on screen the paper copy is not shown; it is one section per order, directly under body
    const sheet = page.getByTestId("workorders-print");
    await expect(sheet).toBeHidden();
    await expect(page.locator("body > .wo-print")).toHaveCount(1);
    await expect(sheet.getByTestId("workorder-page")).toHaveCount(2);

    // print media: white paper, black text, no 3D canvas or app chrome, a page break after every order but the last
    await page.emulateMedia({ media: "print" });
    await expect(sheet).toBeVisible();
    await expect(page.locator("canvas")).toBeHidden();
    await expect(page.locator("[data-lab-root]")).toBeHidden();
    await expect(page.locator("main")).toBeHidden();
    const pages = sheet.getByTestId("workorder-page");
    await expect(pages.nth(0)).toBeVisible();
    await expect(pages.nth(0)).toContainText("Secure and re-route the loose cable");
    await expect(pages.nth(0)).toContainText("P1");
    await expect(pages.nth(0)).toContainText("Location");
    await expect(pages.nth(0)).toContainText("(66.0, 30.0) cm");
    await expect(pages.nth(0)).toContainText("Completed by");
    await expect(pages.nth(0)).toContainText("Written by offline rules, no model");
    await expect(pages.nth(1)).toContainText("Remove the foreign object");
    const css = await page.evaluate(() => {
      const ps = [...document.querySelectorAll<HTMLElement>("[data-testid='workorder-page']")];
      const text = getComputedStyle(ps[0]);
      return {
        bodyBg: getComputedStyle(document.body).backgroundColor,
        color: text.color,
        sheetBg: getComputedStyle(document.querySelector(".wo-print")!).backgroundColor,
        breaks: ps.map((p) => getComputedStyle(p).breakAfter),
        title: getComputedStyle(ps[0].querySelector("h1")!).color,
      };
    });
    expect(css).toEqual({ bodyBg: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", sheetBg: "rgb(255, 255, 255)", breaks: ["page", "auto"], title: "rgb(0, 0, 0)" });
    await expect(pages.nth(0).locator("img")).toHaveAttribute("src", `${BACKEND}/api/inspection/frames/${mission.captureIds[0]}`);

    // back on screen the app is back
    await page.emulateMedia({ media: "screen" });
    await expect(page.locator("canvas")).toBeVisible();
    await expect(sheet).toBeHidden();
  });

  test("a live Muse Spark list shows its provenance and what was dropped, and Hindi is asked for in Hindi", async ({ lab, page }) => {
    await mockProviders(page, "LIVE");
    await lab.openOnline();
    const mission = await seedMission(page);
    const asked: unknown[] = [];
    const next: WorkOrdersResponse[] = [
      liveList(mission.captureIds),
      liveList(mission.captureIds, { language: "hi", droppedEvidence: [], droppedOrders: 0, orders: [{ ...liveList(mission.captureIds).orders[0], title: "केबल को सुरक्षित करें", action: "केबल की जाँच करें, फिर उसे बाँधें।" }] }),
    ];
    await page.route("**/api/inspection/*/work-orders", (route) => {
      asked.push(route.request().postDataJSON());
      return route.fulfill({ json: next.shift(), headers: CORS });
    });
    await showReport(lab, page, mission);
    await expect(page.getByTestId("workorders-writer")).toHaveText("MUSE SPARK 1.3");
    await expect(page.getByTestId("workorders-writer")).toHaveAttribute("data-status", "LIVE");

    await generate(page).click();
    await expect(cards(page)).toHaveCount(2);
    expect(asked).toEqual([{ language: "en" }]);
    await expect(panel(page)).toHaveAttribute("data-provider", "MUSE_SPARK");
    await expect(page.getByTestId("workorders-badges")).toContainText("MUSE SPARK 1.3");
    await expect(page.getByTestId("workorders-badges").locator("[data-exec]")).toHaveAttribute("data-exec", "LIVE_META");
    await expect(page.getByTestId("workorders-badges")).not.toContainText("OFFLINE");
    await expect(panel(page)).toContainText("1 Meta request logged / 1 order dropped: 1 cited capture no record holds");
    await expect(cards(page).nth(0)).toHaveAttribute("data-priority", "P1");
    await expect(cards(page).nth(1)).toHaveAttribute("data-priority", "P3");
    await expect(cards(page).nth(0).locator("h4")).not.toHaveAttribute("lang", "hi");
    await expect(panel(page).getByTestId("hindi-needs-meta")).toHaveCount(0);

    await panel(page).getByRole("radio", { name: "हिन्दी" }).click();
    await expect(generate(page)).toHaveText(/Regenerate/);
    await generate(page).click();
    await expect(cards(page)).toHaveCount(1);
    expect(asked).toEqual([{ language: "en" }, { language: "hi" }]);
    await expect(cards(page).first().locator("h4")).toHaveText("केबल को सुरक्षित करें");
    await expect(cards(page).first().locator("h4")).toHaveAttribute("lang", "hi");
    await expect(cards(page).first()).toHaveAttribute("data-priority", "P1"); // enums stay English
    await expect(panel(page)).not.toContainText("dropped");
  });

  test("a locked backend writes the orders from the rules and reads as locked, not offline or live", async ({ lab, page }) => {
    await mockProviders(page, "LIVE_LOCKED");
    await lab.openOnline();
    const mission = await seedMission(page);
    const locked = liveList(mission.captureIds, {
      provider: "OFFLINE_RULES", model: null, executionIds: [], classification: null, fallback: "LIVE_LOCKED", droppedEvidence: [], droppedOrders: 0,
      note: "Live mode is locked: the offline rules wrote the orders, not Muse Spark.",
    });
    await page.route("**/api/inspection/*/work-orders", (route) => route.fulfill({ json: locked, headers: CORS }));
    await showReport(lab, page, mission);
    await expect(page.getByTestId("workorders-writer")).toHaveText("LIVE LOCKED");
    await expect(page.getByTestId("workorders-writer")).toHaveAttribute("data-status", "LIVE_LOCKED");

    await generate(page).click();
    await expect(cards(page)).toHaveCount(2);
    await expect(page.getByTestId("workorders-badges")).toContainText("LIVE LOCKED");
    await expect(page.getByTestId("workorders-badges")).toContainText("OFFLINE RULES");
    await expect(page.getByTestId("workorders-badges")).not.toContainText("MUSE SPARK");
    await expect(panel(page)).toContainText("Live mode is locked");
  });

  test("a failed request is shown and the button works again", async ({ lab, page, audit }) => {
    audit.allow.push(/status of 500/); // the browser logs the refused request itself
    await lab.openOnline();
    const mission = await seedMission(page);
    await page.route("**/api/inspection/*/work-orders", (route) => route.fulfill({ status: 500, json: { error: "boom" }, headers: CORS }));
    await showReport(lab, page, mission);
    await generate(page).click();
    await expect(panel(page)).toHaveAttribute("data-status", "FAILED");
    await expect(panel(page)).toContainText("boom");
    await expect(cards(page)).toHaveCount(0);
    await expect(printButton(page)).toBeDisabled();
    await expect(generate(page)).toBeEnabled();
  });
});
