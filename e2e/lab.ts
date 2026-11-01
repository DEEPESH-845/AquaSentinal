import { expect, type Page, test as base } from "@playwright/test";
import type { useSimStore } from "@/lib/sim/store";
import type { useMissionStore } from "@/lib/store/mission";

type Store = typeof useSimStore;
type State = ReturnType<Store["getState"]>;
type MStore = typeof useMissionStore;
type MState = ReturnType<MStore["getState"]>;

declare global {
  interface Window {
    __labStore?: Store;
    __missionStore?: MStore;
    __labStats?: { calls: number; triangles: number };
    /** dev-only: live main camera and orbit controls, plus whether a preset tween is running */
    __labCamera?: { camera: { position: { x: number; y: number; z: number } }; controls: { target: { x: number; y: number; z: number } } | null; tweening: () => boolean };
  }
}

/** Console errors, uncaught exceptions and failed requests collected for the whole test. */
export interface ConsoleAudit {
  errors: string[];
  warnings: string[];
  /** a test that provokes failures on purpose (backend offline) lists the ones it expects here */
  allow: RegExp[];
}

/** Upstream warnings that are understood and harmless. Anything else fails the audit. */
const KNOWN_WARNINGS = [/THREE\.Clock: This module has been deprecated/, /GPU stall due to ReadPixels/];

export const test = base.extend<{ audit: ConsoleAudit; lab: Lab }>({
  audit: async ({ page }, provide) => {
    const audit: ConsoleAudit = { errors: [], warnings: [], allow: [] };
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() === "error") audit.errors.push(text);
      else if (m.type() === "warning" && !KNOWN_WARNINGS.some((re) => re.test(text))) audit.warnings.push(text);
    });
    page.on("pageerror", (e) => audit.errors.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) => {
      // a download or navigation aborted by the test itself is not a failure of the app
      if (r.failure()?.errorText === "net::ERR_ABORTED" && /\.(md|json)(\?|$)|format=md/.test(r.url())) return;
      audit.errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`);
    });
    await provide(audit);
    expect(audit.errors.filter((e) => !audit.allow.some((re) => re.test(e))), "console/page/request errors").toEqual([]);
  },
  lab: async ({ page, audit }, provide) => {
    void audit;
    await provide(new Lab(page));
  },
});

export { expect };

/** Store-backed helpers. Reads go through the dev hooks; actions go through the DOM unless noted. */
export class Lab {
  constructor(readonly page: Page) {}

  async open() {
    await this.page.goto("/");
    await this.page.waitForFunction(() => !!window.__labStore && !!window.__missionStore && !!document.querySelector("canvas"));
    // one published snapshot means the sim loop is alive
    await this.page.waitForFunction(() => (window.__labStore!.getState().telemetry.time ?? 0) > 0);
  }

  /** open() plus a confirmed backend connection, for tests that need missions or captures. */
  async openOnline() {
    // The backend's motion gate is global state: a previous test may have left its emergency stop latched.
    await this.page.request.post("http://localhost:8000/api/gantry/command", { data: { v: 1, id: "e2e-clear", command: { type: "CLEAR_ESTOP" } } });
    await this.open();
    await this.waitMission((m) => m.backend === "ONLINE", undefined, 30_000);
  }

  /** Read from canonical store state. `fn` is serialised, so it must not close over test variables. */
  state<T>(fn: (s: State) => T): Promise<T> {
    return this.page.evaluate(`(${fn.toString()})(window.__labStore.getState())`) as Promise<T>;
  }

  mission<T>(fn: (s: MState) => T): Promise<T> {
    return this.page.evaluate(`(${fn.toString()})(window.__missionStore.getState())`) as Promise<T>;
  }

  /** Wait until a predicate on store state holds. `pred` is serialised: pass test-scope values through `arg`. */
  async waitFor<A = undefined>(pred: (s: State, arg: A) => boolean, arg?: A, timeout = 60_000) {
    await this.page.waitForFunction(
      ({ src, arg }) => new Function("s", "arg", `return (${src})(s, arg)`)(window.__labStore!.getState(), arg) as boolean,
      { src: pred.toString(), arg },
      { timeout, polling: 100 },
    );
  }

  async waitMission<A = undefined>(pred: (s: MState, arg: A) => boolean, arg?: A, timeout = 60_000) {
    await this.page.waitForFunction(
      ({ src, arg }) => new Function("s", "arg", `return (${src})(s, arg)`)(window.__missionStore!.getState(), arg) as boolean,
      { src: pred.toString(), arg },
      { timeout, polling: 100 },
    );
  }

  /**
   * Fast-forward the engine by `seconds` of simulated time. The scripted demo is clocked separately, so this only
   * accelerates engine-driven waits (missions, moves). Captures emitted meanwhile are still rendered, one per frame.
   */
  async fastForward(seconds: number) {
    await this.page.evaluate((secs) => {
      const s = window.__labStore!.getState();
      for (let t = 0; t < secs; t += 0.05) s.engine.tick(0.05);
      s.publish();
    }, seconds);
  }

  /** Fast-forward in slices until the predicate holds, letting the render loop process captures between slices. */
  async fastForwardUntil<A = undefined>(pred: (s: State, arg: A) => boolean, arg?: A, maxSimSeconds = 300, slice = 2) {
    for (let t = 0; t < maxSimSeconds; t += slice) {
      const done = await this.page.evaluate(({ src, arg }) => new Function("s", "arg", `return (${src})(s, arg)`)(window.__labStore!.getState(), arg) as boolean, { src: pred.toString(), arg });
      if (done) return;
      await this.fastForward(slice);
      await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    throw new Error(`condition not reached within ${maxSimSeconds} s of simulated time`);
  }

  rail(name: string | RegExp) {
    return this.page.locator("nav[aria-label='Scenes']").getByRole("button", { name });
  }

  button(name: string | RegExp) {
    return this.page.getByRole("button", { name });
  }

  card() {
    return this.page.locator('[data-lab="card"]');
  }

  async scene(n: number) {
    await this.rail(new RegExp(`^0${n}`)).click();
    await this.waitFor((s, n) => s.scene === n, n);
  }

  /** Plan the example instruction through the UI and wait for the reviewed plan. */
  async planExample() {
    await this.scene(5);
    await this.page.getByRole("button", { name: /use the example instruction/i }).click();
    await this.button(/plan mission/i).click();
    await this.waitMission((m) => m.mission?.status === "PLANNED", undefined, 30_000);
  }
}
