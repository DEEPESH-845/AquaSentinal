import type { Page } from "@playwright/test";
import { expect, test } from "./lab";

const API = "http://localhost:8000";
/** Chrome logs every refused request as a console error; the abuse below provokes some on purpose. */
const REFUSED = /Failed to load resource: the server responded with a status of (409|422)/;

/** The twin must always be somewhere real: finite, on the rails, and in a known mode. */
const sane = (s: ReturnType<NonNullable<Window["__labStore"]>["getState"]>) => {
  const g = s.engine.gantry;
  const t = s.telemetry;
  return {
    onRails: Number.isFinite(g.x.pos) && Number.isFinite(g.y.pos) && g.x.pos >= 0 && g.x.pos <= 100 && g.y.pos >= 0 && g.y.pos <= 40,
    finite: [t.gantry.x, t.gantry.y, t.environment.visibility, t.environment.turbidity, t.environment.lighting].every(Number.isFinite),
    mode: ["IDLE", "MANUAL", "TRACK", "EPISODE", "TEST", "MISSION"].includes(s.mode),
  };
};
const SANE = { onRails: true, finite: true, mode: true };

const backendEstop = async (page: Page) => (await (await page.request.get(`${API}/api/telemetry`)).json()).gantry.estop as boolean;

test.describe("red team", () => {
  test("rapid random clicks across scenes and buttons keep the twin sane and reset cleanly", async ({ lab, page, audit }) => {
    test.setTimeout(240_000);
    audit.allow.push(REFUSED);
    await lab.openOnline();
    let r = 7;
    const rand = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pad = page.getByTestId("xy-pad");
    for (let i = 0; i < 90; i++) {
      const buttons = page.locator("button:visible:enabled");
      const n = await buttons.count();
      if (rand() < 0.15 && (await pad.count())) {
        const b = (await pad.boundingBox())!;
        await page.mouse.click(b.x + rand() * b.width, b.y + rand() * b.height);
      } else if (n > 0) {
        await buttons.nth(Math.floor(rand() * n)).click({ timeout: 2000, force: true }).catch(() => undefined);
      }
      if (i % 10 === 9) expect(await lab.state(sane), `after click ${i}`).toEqual(SANE);
    }
    // leave whatever the clicks started: closing moment, demo, e-stop
    await page.keyboard.press("Escape");
    if (await lab.state((s) => s.demo.active)) await lab.button(/exit demo/i).click();
    await lab.waitFor((s) => !s.demo.active && !s.showVision);
    if (await lab.button(/clear e-stop/i).count()) await lab.button(/clear e-stop/i).click();
    await lab.button(/^reset lab$/i).click();
    const after = await lab.state((s) => ({ mode: s.mode, phase: s.phase, x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, rl: s.rl.active, demo: s.demo.active, estop: s.telemetry.estop, mission: s.mission }));
    expect(after).toEqual({ mode: "IDLE", phase: "IDLE", x: 50, y: 20, rl: false, demo: false, estop: false, mission: null });
  });

  test("hostile text in the instruction box is inert and every plan request ends planned or refused", async ({ lab, page, audit }) => {
    audit.allow.push(REFUSED);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await lab.openOnline();
    await lab.scene(5);
    const box = page.locator("#instruction");
    const plan = lab.button(/plan mission/i);
    const hostile = [
      "<img src=x onerror=alert(1)>",
      "<script>alert(2)</script>",
      "'; DROP TABLE missions; --",
      "{{7*7}} ${process.env.MODEL_API_KEY} %s %n",
      "../../etc/passwd",
      "inspect ‮ the tank 🌊🌊\n\n\ttabbed\n",
      "go ".repeat(300),
    ];
    for (const text of hostile) {
      await box.fill(text);
      await expect(box).toHaveValue(text);
      await plan.click();
      await lab.waitMission((s) => !s.interpreting && (s.mission?.status === "PLANNED" || s.interpretError !== null), undefined, 30_000);
      expect(await lab.mission((s) => s.mission?.status === "PLANNED" ? "planned" : "refused")).toBe("planned");
      await expect(lab.card().locator("img, script, iframe")).toHaveCount(0);
      await lab.button(/^discard$/i).click();
      await lab.waitMission((s) => s.mission === null);
    }
    expect(dialogs).toEqual([]);

    // too short or blank: the button refuses before any request is made
    for (const text of ["", "  ", "ab"]) {
      await box.fill(text);
      await expect(plan).toBeDisabled();
    }
    // typed or pasted text stops at the backend's 2000 character limit instead of failing later with an opaque 422
    await box.fill("");
    await box.focus();
    await page.keyboard.insertText("x".repeat(5000));
    expect((await box.inputValue()).length).toBe(2000);
    expect(await lab.state(sane)).toEqual(SANE);
  });

  test("number fields and sliders clamp every value and ignore garbage", async ({ lab, page }) => {
    await lab.open();
    await lab.scene(6);
    await page.getByRole("button", { name: /object positions/i }).click();
    const bounds = async () =>
      lab.state((s) => s.scenario.objects.every((o) => Number.isFinite(o.x) && Number.isFinite(o.y) && o.x >= 3 && o.x <= 97 && o.y >= 3 && o.y <= 37));
    const x = page.getByRole("spinbutton", { name: "Loose cable X" });
    const y = page.getByRole("spinbutton", { name: "Loose cable Y" });
    for (const v of ["-5", "99999", "1e3", "0.4", "-0", "3.7", "-1e9", "0", "97", "98", ""]) {
      await x.fill(v);
      await y.fill(v);
      await y.blur();
      await x.blur();
      expect(await bounds(), `after "${v}"`).toBe(true);
    }
    // letters and signs typed by hand never reach the store
    await x.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("abc--e+.e9");
    await x.blur();
    expect(await bounds()).toBe(true);
    await expect(x).toHaveValue(/^\d+$/);

    const turbidity = page.locator("label", { hasText: "Turbidity" }).locator("input[type=range]");
    for (const v of ["0", "1", "0.55", "-3", "9"]) {
      await turbidity.fill(v).catch(() => undefined);
      const t = await lab.state((s) => s.scenario.turbidity);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
    expect(await lab.state(sane)).toEqual(SANE);
  });

  test("reset during a mission ends it on both sides and the lab can plan and run again", async ({ lab }) => {
    test.setTimeout(300_000);
    await lab.openOnline();
    await lab.planExample();
    await lab.button(/approve and run/i).click();
    await lab.waitFor((s) => s.mode === "MISSION");
    await lab.fastForwardUntil((s) => (s.mission?.waypointIndex ?? 0) >= 2, undefined, 60, 1);
    await lab.button(/^reset lab$/i).click();
    expect(await lab.state((s) => ({ mode: s.mode, phase: s.phase, x: s.telemetry.gantry.x, y: s.telemetry.gantry.y, mission: s.mission, result: s.missionResult }))).toEqual({
      mode: "IDLE",
      phase: "IDLE",
      x: 50,
      y: 20,
      mission: null,
      result: null,
    });
    // the backend record must not stay RUNNING with nothing executing it
    await lab.waitMission((s) => s.mission?.status === "ABORTED", undefined, 30_000);
    // the finished mission no longer locks the instruction box: plan the same text again
    await lab.scene(5);
    await expect(lab.page.locator("#instruction")).toBeEnabled();
    await lab.button(/plan mission/i).click();
    await lab.waitMission((s) => s.mission?.status === "PLANNED", undefined, 30_000);
    await lab.button(/approve and run/i).click();
    await lab.waitFor((s) => s.mode === "MISSION");
    await lab.fastForwardUntil((s) => s.mode !== "MISSION", undefined, 200);
    expect((await lab.state((s) => s.missionResult!)).outcome).toBe("COMPLETED");
    await lab.waitMission((s) => s.mission?.status === "COMPLETED" && s.report?.mission.id === s.mission.id, undefined, 60_000);
  });

  test("e-stop spam ends consistent: the button offers a way out whenever either side is latched", async ({ lab, page }) => {
    await lab.openOnline();
    // one button, two faces: it is "Emergency stop" when clear and "Clear e-stop" when latched
    const estop = page.getByRole("button", { name: /emergency stop|clear e-stop/i });
    for (let i = 0; i < 24; i++) await estop.click({ delay: 0 });
    await estop.dblclick();
    await lab.mission((s) => s.refreshStatus());
    const twin = await lab.state((s) => s.telemetry.estop);
    const backend = await lab.mission((s) => s.system!.gantry.estop);
    expect(await backendEstop(page)).toBe(backend);
    // the UI shows the latched face exactly when either latch is set
    await expect(lab.button(/clear e-stop/i)).toHaveCount(twin || backend ? 1 : 0);
    if (twin || backend) await lab.button(/clear e-stop/i).click();
    await lab.waitFor((s) => !s.telemetry.estop);
    await expect.poll(() => backendEstop(page)).toBe(false);
    await expect(lab.button(/^emergency stop$/i)).toBeVisible();
    expect(await lab.state(sane)).toEqual(SANE);
  });

  test("reload during a mission starts fresh and demo interrupts leave a clean lab", async ({ lab }) => {
    test.setTimeout(240_000);
    await lab.openOnline();
    await lab.planExample();
    await lab.button(/approve and run/i).click();
    await lab.waitFor((s) => s.mode === "MISSION");
    await lab.open();
    expect(await lab.state((s) => ({ mode: s.mode, scene: s.scene, x: s.telemetry.gantry.x, result: s.missionResult }))).toEqual({ mode: "IDLE", scene: 1, x: 50, result: null });

    await lab.button(/run demo/i).click();
    await lab.waitFor((s) => s.demo.active);
    await lab.button(/exit demo/i).click();
    expect(await lab.state((s) => [s.demo.active, s.mode])).toEqual([false, "IDLE"]);
    await lab.button(/run demo/i).click();
    await lab.waitFor((s) => s.demo.active && s.demo.t > 0.5);
    await lab.button(/replay/i).click();
    await lab.waitFor((s) => s.demo.active && s.demo.phase === 0 && s.demo.t < 0.5 && s.scene === 1);
    await lab.button(/exit demo/i).click();
    await lab.button(/^reset lab$/i).click();
    expect(await lab.state((s) => [s.mode, s.demo.active, s.preset, s.result])).toEqual(["IDLE", false, null, null]);
  });
});
