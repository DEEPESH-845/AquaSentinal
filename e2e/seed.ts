import type { Page } from "@playwright/test";
import type { SystemStatus } from "@/lib/api/types";

/** Shared by the specs that need a stored mission and a backend that reports a key (Ask the inspector, Work orders). */

export const BACKEND = "http://localhost:8000";
export const CORS = { "access-control-allow-origin": "*" };

/** Serve the status as if the backend had a key: every provider in `status`. */
export async function mockProviders(page: Page, status: "LIVE" | "LIVE_LOCKED") {
  const base = (await (await page.request.get(`${BACKEND}/api/system/status`)).json()) as SystemStatus;
  await page.route("**/api/system/status", (route) => {
    const p = (k: "spark" | "sam" | "voice") => ({ ...base.providers[k], status, fallback: status === "LIVE" ? null : "OFFLINE_RULE_PARSER" });
    return route.fulfill({ json: { ...base, providers: { spark: p("spark"), sam: p("sam"), voice: p("voice") }, live: { lockEnabled: status === "LIVE_LOCKED", unlocked: status === "LIVE" } }, headers: CORS });
  });
}

/**
 * A planned, started mission with two stored captures, as the twin would send them: the loose cable at (66, 30) and the dropped wrench
 * at (85, 9), where the default scenario keeps them. Frames are drawn in the page and posted to the real capture route.
 */
export async function seedMission(page: Page): Promise<{ id: string; captureIds: string[] }> {
  return page.evaluate(async (backend) => {
    const post = async (path: string, body: unknown) => {
      const res = await fetch(backend + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    };
    const { mission } = await post("/api/ai/interpret?offline=true", { instruction: "inspect the pipeline for loose cables and foreign objects" });
    await post(`/api/missions/${mission.id}/start`, { executor: "TWIN" });
    const frame = (seq: number) => {
      const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 480 });
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#7896aa";
      g.fillRect(0, 0, 640, 480);
      let s = seq * 9301 + 49297;
      for (let i = 0; i < 3000; i++) {
        s = (s * 9301 + 49297) % 233280;
        const a = s / 233280;
        s = (s * 9301 + 49297) % 233280;
        const b = s / 233280;
        g.fillStyle = `rgba(${60 + a * 80}, ${90 + b * 80}, ${110 + a * 60}, 0.6)`;
        g.fillRect(a * 640, b * 480, 7, 7);
      }
      g.fillStyle = "#282d32";
      g.fillRect(100 + seq * 200, 200, 160, 60);
      return new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg", 0.9));
    };
    const detection = (objectId: string, type: string, x: number, y: number, confidence: number) => ({ objectId, trueType: type, class: type, confidence, bbox: [0.4, 0.4, 0.2, 0.1], estX: x, estY: y });
    const captures: Array<[number, number, number, ReturnType<typeof detection>]> = [
      [0, 60, 28, detection("cable-1", "LOOSE_CABLE", 66, 30, 0.8)],
      [1, 82, 12, detection("wrench-1", "FOREIGN_OBJECT", 85, 9, 0.9)],
    ];
    const captureIds: string[] = [];
    for (const [seq, gantryX, gantryY, det] of captures) {
      const meta = {
        missionId: mission.id, seq, reason: "SCAN", waypointIndex: seq, time: seq * 4, gantryX, gantryY, visibility: 0.9, turbidity: 0.15, lighting: 0.8,
        perception: "NORMAL_VISIBILITY", cameraOnline: true, source: "DIGITAL_TWIN", detections: [det], idMap: [], targets: ["loose_cable", "foreign_object"], perceptionFault: "NONE", prompts: [],
      };
      const form = new FormData();
      form.append("meta", JSON.stringify(meta));
      form.append("frame", await frame(seq), `frame-${seq}.jpg`);
      const res = await fetch(backend + "/api/inspection/capture", { method: "POST", body: form });
      if (!res.ok) throw new Error(`capture ${seq}: HTTP ${res.status}`);
      captureIds.push((await res.json()).captureId);
    }
    return { id: mission.id as string, captureIds };
  }, BACKEND);
}

/**
 * Where the report tracks an object, formatted as the answers and orders print it. An asset keeps one position across missions, so
 * sightings left by earlier specs in the same backend can move it a fraction of a centimetre from where this mission saw it.
 */
export const trackedAt = (page: Page, label: string) =>
  page.evaluate((label) => {
    const a = window.__missionStore!.getState().report!.assets.find((a) => a.label === label)!;
    return `(${a.x.toFixed(1)}, ${a.y.toFixed(1)}) cm`;
  }, label);
