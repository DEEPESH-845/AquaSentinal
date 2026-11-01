/**
 * Cross-language contract fixtures. `npm run fixtures` writes them to shared/fixtures; sim:check fails if the TypeScript
 * output drifts from the committed files, and backend pytest checks the Python ports against the same files.
 */
import { CAMERA, gantryToWorld, worldToGantry } from "./constants";
import { createGantry, setGantryTarget, stepGantry } from "./gantry";

export function trajectoryFixture() {
  const g = createGantry();
  const legs: Array<[number, number]> = [
    [10, 5],
    [90, 35],
    [50, 20],
    [50.05, 20.1],
  ];
  const speed = 0.65;
  const samples: Array<[number, number, number, number]> = [];
  let step = 0;
  for (const [x, y] of legs) {
    setGantryTarget(g, x, y);
    for (let i = 0; i < 120 * 30; i++) {
      stepGantry(g, 1 / 120, speed);
      step += 1;
      if (step % 12 === 0) samples.push([g.x.pos, g.y.pos, g.x.vel, g.y.vel]);
      if (!g.moving && g.x.pos === g.x.target && g.y.pos === g.y.target) break;
    }
  }
  return { start: [50, 20], speedFraction: speed, legs, sampleEverySubsteps: 12, samples };
}

/** Feed pixel -> gantry cm, the same back-projection detection.ts uses for estX/estY. */
export function projectionFixture() {
  const tanH = Math.tan((CAMERA.hfovDeg * Math.PI) / 360);
  const tanV = tanH / CAMERA.aspect;
  const W = CAMERA.captureWidth;
  const H = CAMERA.captureHeight;
  const cases: Array<{ px: number; py: number; gx: number; gy: number; x: number; y: number }> = [];
  for (const [px, py, gx, gy] of [
    [320, 240, 50, 20],
    [0, 0, 50, 20],
    [640, 480, 10, 5],
    [100, 400, 90, 35],
  ] as const) {
    const [cx, cz] = gantryToWorld(gx, gy);
    const wx = cx + ((px / W) * 2 - 1) * CAMERA.lensHeight * tanH;
    const wz = cz + ((py / H) * 2 - 1) * CAMERA.lensHeight * tanV;
    const [x, y] = worldToGantry(wx, wz);
    cases.push({ px, py, gx, gy, x, y });
  }
  return { width: W, height: H, cases };
}
