import type { Page, Route } from "@playwright/test";
import type { RealSegmentResponse } from "@/lib/api/types";
import { expect, test } from "./lab";
import { CORS, mockProviders } from "./seed";

/**
 * Real water camera (header camera button -> "Real water" panel). Chromium's fake capture device stands in for the camera
 * (a 640 x 480 test pattern); the segment route is mocked where a live SAM 3.1 answer is needed, because the e2e backend has no
 * key. The route's own behaviour (validation, the two-prompt cap, lock, cache, budget) is covered by backend/tests/test_realwater.py.
 * The GL flags are repeated because `launchOptions` replaces the config's list, and the 3D scene needs them.
 */
test.use({
  launchOptions: {
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

const SEGMENT = "**/api/ai/segment-image";
const dialog = (page: Page) => page.getByTestId("realcam-dialog");
const shutter = (page: Page) => page.getByTestId("realcam-shutter");
const chip = (page: Page, prompt: string) => page.locator(`[data-testid=realcam-chip][data-prompt="${prompt}"]`);

/** The request body of a shutter: the phrases and the size of the JPEG that was sent. */
interface Sent {
  prompts: string[];
  width: number;
  height: number;
  bytes: number;
  isJpeg: boolean;
}

/** Dimensions from the first start-of-frame marker of a JPEG. */
function jpegSize(buf: Buffer): [number, number] {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return [0, 0];
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return [0, 0];
}

function parseMultipart(route: Route): Sent {
  const body = route.request().postDataBuffer()!;
  const text = body.toString("latin1");
  const prompts = [...text.matchAll(/name="prompt"\r\n\r\n([^\r]*)\r\n/g)].map((m) => m[1]);
  const start = text.indexOf("\r\n\r\n", text.indexOf('name="frame"')) + 4;
  const end = text.indexOf("\r\n--", start);
  const jpeg = body.subarray(start, end);
  const [width, height] = jpegSize(jpeg);
  return { prompts, width, height, bytes: jpeg.length, isJpeg: jpeg[0] === 0xff && jpeg[1] === 0xd8 };
}

/** A SAM 3.1 answer shaped like the backend's: a box-shaped polygon per phrase. */
function liveAnswer(prompts: string[], patch: Partial<RealSegmentResponse> = {}): RealSegmentResponse {
  const box = (i: number): [number, number, number, number] => [60 + i * 280, 120, 200 + i * 280, 260];
  return {
    width: 640,
    height: 480,
    segments: prompts.map((prompt, i) => {
      const [x0, y0, x1, y1] = box(i);
      return {
        prompt,
        status: "OK" as const,
        latencyMs: 412 + i * 100,
        error: null,
        instances: [{ box: [x0, y0, x1, y1], confidence: 0.91 - i * 0.1, areaPx: (x1 - x0) * (y1 - y0), polygons: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] as Array<Array<[number, number]>> }],
      };
    }),
    provider: "SAM_3_1",
    model: "sam-3.1",
    executionIds: prompts.map((_, i) => `exe_${i}`),
    classification: "LIVE_META",
    latencyMs: 412 + (prompts.length - 1) * 100,
    costUsd: prompts.length * 0.0025,
    fallback: null,
    note: "",
    ...patch,
  };
}

/** Answers every shutter with `answer(prompts)` and records what was sent. */
async function mockSegment(page: Page, answer: (prompts: string[]) => RealSegmentResponse = (p) => liveAnswer(p)) {
  const sent: Sent[] = [];
  await page.route(SEGMENT, (route) => {
    const s = parseMultipart(route);
    sent.push(s);
    return route.fulfill({ json: answer(s.prompts), headers: CORS });
  });
  return sent;
}

async function openPanel(page: Page) {
  await page.getByTestId("realcam-open").click();
  await expect(dialog(page)).toBeVisible();
}

/** The fake device is playing: the shutter is enabled and a frame has dimensions. */
async function cameraLive(page: Page) {
  await expect(shutter(page)).toBeEnabled({ timeout: 20_000 });
  await expect.poll(() => page.getByTestId("realcam-video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
}

/** A JPEG of the given size drawn in the page, as a file an operator would upload. */
async function photo(page: Page, width: number, height: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([w, h]) => {
      const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#3a6a7a";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#c9a227";
      g.fillRect(w * 0.2, h * 0.4, w * 0.4, h * 0.1);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    },
    [width, height],
  );
  return Buffer.from(b64, "base64");
}

test.describe("Real water camera", () => {
  test("the shutter sends one downscaled JPEG and the masks are drawn over the still, with latency, cost and provider", async ({ lab, page }) => {
    await mockProviders(page, "LIVE");
    const sent = await mockSegment(page);
    await lab.openOnline();
    await openPanel(page);
    await expect(dialog(page).getByRole("heading", { name: "Real water" })).toBeVisible();
    await expect(page.getByTestId("realcam-provider")).toHaveText("SAM 3.1");
    await cameraLive(page);

    // cable is picked by default; rope makes two prompts, which is the limit
    await expect(chip(page, "cable")).toHaveAttribute("aria-pressed", "true");
    await chip(page, "rope").click();
    await shutter(page).click();

    await expect(page.getByTestId("realcam-still")).toBeVisible();
    await expect(page.getByTestId("realcam-mask")).toHaveCount(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].prompts).toEqual(["cable", "rope"]);
    expect(sent[0].isJpeg).toBe(true);
    expect([sent[0].width, sent[0].height]).toEqual([640, 480]); // the fake device is already under 1024 px: not upscaled
    expect(sent[0].bytes).toBeLessThan(4 * 1024 * 1024);

    // provenance: the model tag and the execution class from the response, never a constant
    const badges = page.getByTestId("realcam-badges");
    await expect(badges).toContainText("SAM 3.1");
    await expect(badges.locator("[data-exec=LIVE_META]")).toBeVisible();
    await expect(page.getByTestId("realcam-stats")).toContainText("latency 512 ms");
    await expect(page.getByTestId("realcam-stats")).toContainText("cost $0.0050");
    await expect(page.getByTestId("realcam-stats")).toContainText("2 Meta requests logged");
    const rows = page.getByTestId("realcam-segment");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("cable");
    await expect(rows.nth(0)).toContainText("1 mask");
    await expect(rows.nth(1)).toContainText("rope");

    // the overlay sits on the picture: polygons in the sent frame's pixels, labelled with the phrase and the model's confidence
    const masks = page.getByTestId("realcam-mask");
    await expect(masks.nth(0)).toContainText("cable 91%");
    await expect(masks.nth(1)).toContainText("rope 81%");
    const poly = await masks.nth(0).locator("polygon").getAttribute("points");
    expect(poly).toBe("60,120 200,120 200,260 60,260");
    const [still, svg] = await Promise.all([page.getByTestId("realcam-still").boundingBox(), page.getByTestId("realcam-overlay").boundingBox()]);
    expect(svg!.x).toBeCloseTo(still!.x, 0);
    expect(svg!.width).toBeCloseTo(still!.width, 0);

    // a new shot returns to the live view
    await page.getByTestId("realcam-new").click();
    await expect(page.getByTestId("realcam-still")).toHaveCount(0);
    await expect(shutter(page)).toBeEnabled();
  });

  test("at most two prompts: chips and the free text give way, and a free-text prompt is sent as typed", async ({ lab, page }) => {
    await mockProviders(page, "LIVE");
    const sent = await mockSegment(page);
    await lab.openOnline();
    await openPanel(page);
    await cameraLive(page);

    await chip(page, "pipe").click();
    await expect(chip(page, "cable")).toHaveAttribute("aria-pressed", "true");
    await expect(chip(page, "pipe")).toHaveAttribute("aria-pressed", "true");
    for (const p of ["plastic bottle", "rope"]) await expect(chip(page, p)).toBeDisabled();
    await expect(page.getByTestId("realcam-custom")).toBeDisabled();
    await expect(page.getByTestId("realcam-prompts")).toContainText("cable + pipe");

    // none picked: no shutter; one chip off and a typed phrase on
    await chip(page, "cable").click();
    await chip(page, "pipe").click();
    await expect(shutter(page)).toBeDisabled();
    await page.getByTestId("realcam-custom").fill("oil sheen");
    await expect(shutter(page)).toBeEnabled();
    await chip(page, "rope").click();
    await expect(chip(page, "pipe")).toBeDisabled();
    await shutter(page).click();
    await expect(page.getByTestId("realcam-mask")).toHaveCount(2);
    expect(sent.map((s) => s.prompts)).toEqual([["rope", "oil sheen"]]);

    // the same still again asks again with the current prompts, without a new frame
    await page.getByTestId("realcam-custom").fill("rope");
    await page.getByTestId("realcam-again").click();
    await expect(page.getByTestId("realcam-segment")).toHaveCount(1);
    expect(sent.map((s) => s.prompts)).toEqual([["rope", "oil sheen"], ["rope"]]);
    expect(sent[1].width).toBe(sent[0].width);
  });

  test("an uploaded photo is downscaled to 1024 px on its long side and sent as JPEG", async ({ lab, page }) => {
    await mockProviders(page, "LIVE");
    const sent = await mockSegment(page);
    await lab.openOnline();
    await openPanel(page);

    await page.getByTestId("realcam-file").setInputFiles({ name: "pond.jpg", mimeType: "image/jpeg", buffer: await photo(page, 2000, 1500) });
    await expect(page.getByTestId("realcam-mask")).toHaveCount(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].isJpeg).toBe(true);
    expect([sent[0].width, sent[0].height]).toEqual([1024, 768]);
    expect(sent[0].prompts).toEqual(["cable"]);

    // a portrait photo is limited on its height, and a small one is left alone
    await page.getByTestId("realcam-new").click();
    await page.getByTestId("realcam-file").setInputFiles({ name: "tall.jpg", mimeType: "image/jpeg", buffer: await photo(page, 1200, 3000) });
    await expect(page.getByTestId("realcam-segment")).toHaveCount(1);
    expect([sent[1].width, sent[1].height]).toEqual([410, 1024]);
    await page.getByTestId("realcam-new").click();
    await page.getByTestId("realcam-file").setInputFiles({ name: "small.jpg", mimeType: "image/jpeg", buffer: await photo(page, 320, 200) });
    await expect(page.getByTestId("realcam-segment")).toHaveCount(1);
    expect([sent[2].width, sent[2].height]).toEqual([320, 200]);

    // not an image: said so, nothing sent
    await page.getByTestId("realcam-new").click();
    await page.getByTestId("realcam-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(dialog(page).getByRole("alert")).toContainText("not an image");
    expect(sent).toHaveLength(3);
  });

  test("no Meta key: the shutter still takes the frame and says SAM 3.1 needs the key, with no overlay (real backend)", async ({ lab, page }) => {
    await lab.openOnline(); // the e2e backend has no MODEL_API_KEY
    const asked: unknown[] = [];
    await page.route(SEGMENT, (route) => {
      asked.push(parseMultipart(route).prompts);
      return route.continue();
    });
    await openPanel(page);
    await expect(page.getByTestId("realcam-provider")).toHaveAttribute("data-status", "OFFLINE");
    await cameraLive(page);
    await shutter(page).click();

    await expect(page.getByTestId("realcam-needs-key")).toHaveText("SAM 3.1 needs the Meta key");
    await expect(page.getByTestId("realcam-still")).toBeVisible();
    await expect.poll(() => page.getByTestId("realcam-still").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(page.getByTestId("realcam-overlay")).toHaveCount(0);
    await expect(page.getByTestId("realcam-mask")).toHaveCount(0);
    await expect(page.getByTestId("realcam-segment")).toHaveCount(0);
    await expect(page.getByTestId("realcam-badges")).toContainText("NO KEY");
    await expect(page.getByTestId("realcam-badges")).toContainText("NO MASK DRAWN");
    await expect(page.getByTestId("realcam-result")).toHaveAttribute("data-fallback", "NO_KEY");
    await expect(page.getByTestId("realcam-unlock")).toHaveCount(0);
    expect(asked).toEqual([["cable"]]);
  });

  test("locked: the same label with LIVE LOCKED, and a way in to the passcode", async ({ lab, page }) => {
    await mockProviders(page, "LIVE_LOCKED");
    await mockSegment(page, () => ({ ...liveAnswer([]), segments: [], provider: "UNAVAILABLE", model: null, executionIds: [], classification: null, latencyMs: null, costUsd: 0, fallback: "LIVE_LOCKED", note: "locked" }));
    await lab.openOnline();
    await openPanel(page);
    await expect(page.getByTestId("realcam-provider")).toHaveAttribute("data-status", "LIVE_LOCKED");
    await cameraLive(page);
    await shutter(page).click();

    await expect(page.getByTestId("realcam-needs-key")).toHaveText("SAM 3.1 needs the Meta key");
    await expect(page.getByTestId("realcam-badges")).toContainText("LIVE LOCKED");
    await expect(page.getByTestId("realcam-mask")).toHaveCount(0);
    await expect(page.getByTestId("realcam-still")).toBeVisible();

    await page.getByTestId("realcam-unlock").click();
    await expect(page.getByTestId("unlock-dialog")).toBeVisible();
  });

  test("a failed request or a refused route keeps the still and says why", async ({ lab, page, audit }) => {
    audit.allow.push(/status of 422/); // the browser logs the refused request itself; the panel shows the reason
    await mockProviders(page, "LIVE");
    let n = 0;
    await page.route(SEGMENT, (route) => {
      n += 1;
      if (n === 1) return route.fulfill({ status: 422, json: { detail: "send one or two prompts per shutter, got 3" }, headers: CORS });
      const refused = liveAnswer(["cable"], { provider: "UNAVAILABLE", classification: null, latencyMs: null, costUsd: 0, executionIds: [], note: "Meta credit budget of $1.00 would be exceeded" });
      refused.segments[0] = { prompt: "cable", status: "SKIPPED_BUDGET", latencyMs: null, error: "Meta credit budget of $1.00 would be exceeded", instances: [] };
      return route.fulfill({ json: refused, headers: CORS });
    });
    await lab.openOnline();
    await openPanel(page);
    await cameraLive(page);
    await shutter(page).click();
    await expect(dialog(page)).toContainText("send one or two prompts per shutter, got 3");
    await expect(page.getByTestId("realcam-still")).toBeVisible();
    await expect(page.getByTestId("realcam-mask")).toHaveCount(0);

    await page.getByTestId("realcam-again").click();
    await expect(page.getByTestId("realcam-badges")).toContainText("BUDGET REACHED");
    await expect(page.getByTestId("realcam-segment")).toHaveAttribute("data-status", "SKIPPED_BUDGET");
    await expect(page.getByTestId("realcam-overlay")).toHaveCount(0);
  });

  test("camera unavailable: the reason is shown, the shutter is off, and uploading still works", async ({ lab, page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    });
    await mockProviders(page, "LIVE");
    const sent = await mockSegment(page);
    await lab.openOnline();
    await openPanel(page);
    await expect(page.getByTestId("realcam-reason")).toContainText("Camera permission was denied");
    await expect(shutter(page)).toBeDisabled();
    await expect(page.getByTestId("realcam-retry")).toBeVisible();

    await page.getByTestId("realcam-file").setInputFiles({ name: "pond.jpg", mimeType: "image/jpeg", buffer: await photo(page, 800, 600) });
    await expect(page.getByTestId("realcam-mask")).toHaveCount(1);
    expect(sent).toHaveLength(1);
  });

  test("no camera API (an insecure origin has none): said so, upload offered", async ({ lab, page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    });
    await lab.openOnline();
    await openPanel(page);
    await expect(page.getByTestId("realcam-reason")).toContainText("exposes no camera API");
    await expect(page.getByTestId("realcam-camera-state")).toContainText("Uploading an image still works");
    await expect(page.getByTestId("realcam-upload")).toBeEnabled();
    await expect(shutter(page)).toBeDisabled();
  });

  test("the panel is keyboard-modal and releases the camera when it closes", async ({ lab, page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __tracks: MediaStreamTrack[] };
      w.__tracks = [];
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await real(c);
        w.__tracks.push(...s.getTracks());
        return s;
      };
    });
    await lab.openOnline();
    await openPanel(page);
    await cameraLive(page);
    const states = () => page.evaluate(() => (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.map((t) => t.readyState));
    expect(await states()).toContain("live");

    // the lab's scene shortcuts do not fire behind the panel
    const scene = await lab.state((s) => s.scene);
    await chip(page, "rope").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("5");
    expect(await lab.state((s) => s.scene)).toBe(scene);

    // Tab stays inside the panel
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid=realcam-dialog]"))).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("realcam-open")).toBeFocused();
    await expect.poll(async () => (await states()).every((s) => s === "ended")).toBe(true);
  });

  test("the camera button is reachable and the panel fits from 320 px to 2560 px", async ({ lab, page }) => {
    await lab.open();
    for (const [w, h] of [[320, 568], [390, 844], [667, 375], [1024, 768], [1440, 900], [2560, 1440]] as const) {
      await page.setViewportSize({ width: w, height: h });
      const open = page.getByTestId("realcam-open");
      await expect(open, `${w}`).toBeVisible();
      await expect(open).toHaveAttribute("aria-label", "Real water camera");
      const b = (await open.boundingBox())!;
      expect(b.x, `${w} left`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, `${w} right`).toBeLessThanOrEqual(w + 1);
      // no other header control sits under it
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-testid]")?.getAttribute("data-testid"), [b.x + b.width / 2, b.y + b.height / 2]);
      expect(hit, `${w} hit`).toBe("realcam-open");
      const brand = (await page.getByText("AQUASENTINAL", { exact: true }).boundingBox())!;
      expect(brand.x + brand.width, `${w} brand clear of the buttons`).toBeLessThanOrEqual(b.x + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${w} overflow`).toBe(0);

      await open.click();
      const panel = (await dialog(page).locator(".panel").boundingBox())!;
      expect(panel.x, `${w} panel left`).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width, `${w} panel right`).toBeLessThanOrEqual(w + 1);
      await expect(shutter(page)).toBeVisible();
      await expect(page.getByTestId("realcam-upload")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${w} overflow with the panel`).toBe(0);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
    }
  });
});
