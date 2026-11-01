"use client";

import * as THREE from "three";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { CAMERA } from "@/lib/sim/constants";
import type { TestObject } from "@/lib/sim/types";

/**
 * Inspection frame capture from the same Three.js scene the operator sees.
 *
 * Frame: the gantry camera rendered at 640 x 480 into a linear HalfFloat target with the live feed's fog, then put through
 * OutputPass so tone mapping and sRGB match the on-screen feed exactly (render targets skip both by default).
 *
 * ID pass: every test object drawn in a flat linear colour (red = 4 x object index), everything else black, no fog,
 * no tone mapping. The result is the twin's ground-truth silhouette per object, used offline for labelled fixture masks
 * and online to score SAM masks by IoU. It is never shown as a model output.
 */

const W = CAMERA.captureWidth;
const H = CAMERA.captureHeight;

export interface CapturePixels {
  rgba: Uint8Array; // top-down RGBA
  ids: Uint8Array; // top-down, one byte per pixel: object index * 4
  idMap: Array<{ index: number; objectId: string; type: string }>;
}

export class CaptureRenderer {
  private linear = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
  private out = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType });
  private idTarget = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, samples: 0 });
  private output = new OutputPass();
  private idMats = new Map<number, THREE.MeshBasicMaterial>();
  private cam: THREE.PerspectiveCamera;
  private black = new THREE.Color(0, 0, 0);

  constructor(template: THREE.PerspectiveCamera) {
    this.cam = template.clone();
  }

  private idMaterial(index: number): THREE.MeshBasicMaterial {
    let m = this.idMats.get(index);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ toneMapped: false, fog: false, side: THREE.DoubleSide });
      m.color.setRGB((index * 4) / 255, 0, 0, THREE.LinearSRGBColorSpace);
      this.idMats.set(index, m);
    }
    return m;
  }

  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, at: [number, number, number], fog: THREE.FogExp2, objects: readonly TestObject[]): CapturePixels {
    const cam = this.cam;
    cam.position.set(at[0], at[1], at[2]);
    cam.up.set(0, 0, -1);
    cam.lookAt(at[0], 0, at[2]);
    cam.updateMatrixWorld();

    const prevTarget = gl.getRenderTarget();
    const prevAutoClear = gl.autoClear;
    const prevBg = scene.background;
    const prevFog = scene.fog;
    gl.setScissorTest(false);
    gl.autoClear = true;

    // --- frame
    scene.background = fog.color;
    scene.fog = fog;
    gl.setRenderTarget(this.linear);
    gl.render(scene, cam);
    this.output.render(gl, this.out, this.linear, 0, false);
    const raw = new Uint8Array(W * H * 4);
    gl.readRenderTargetPixels(this.out, 0, 0, W, H, raw);

    // --- ID pass
    const index = new Map(objects.map((o, i) => [o.id, i + 1]));
    const swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        let idx = 0;
        for (let p: THREE.Object3D | null = o; p; p = p.parent) {
          const hit = index.get(p.name);
          if (hit) {
            idx = hit;
            break;
          }
        }
        swapped.push([mesh, mesh.material]);
        mesh.material = this.idMaterial(idx);
      } else if (((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) && o.visible) {
        hidden.push(o);
        o.visible = false;
      }
    });
    scene.background = this.black;
    scene.fog = null;
    gl.setRenderTarget(this.idTarget);
    gl.render(scene, cam);
    const idRaw = new Uint8Array(W * H * 4);
    gl.readRenderTargetPixels(this.idTarget, 0, 0, W, H, idRaw);
    for (const [m, mat] of swapped) m.material = mat;
    for (const o of hidden) o.visible = true;

    scene.background = prevBg;
    scene.fog = prevFog;
    gl.setRenderTarget(prevTarget);
    gl.autoClear = prevAutoClear;

    // GL rows are bottom-up; images are top-down.
    const rgba = new Uint8Array(W * H * 4);
    const ids = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4;
      rgba.set(raw.subarray(src, src + W * 4), y * W * 4);
      for (let x = 0; x < W; x++) ids[y * W + x] = idRaw[src + x * 4];
    }
    return { rgba, ids, idMap: objects.map((o, i) => ({ index: i + 1, objectId: o.id, type: o.type })) };
  }

  dispose(): void {
    this.linear.dispose();
    this.out.dispose();
    this.idTarget.dispose();
    this.output.dispose();
    this.idMats.forEach((m) => m.dispose());
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas encode failed"))), type, quality));
}

/** JPEG for the frame, lossless PNG for the ID pass (red channel carries the index). */
export async function encodeCapture(p: CapturePixels): Promise<{ jpeg: Blob; png: Blob }> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  img.data.set(p.rgba);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  ctx.putImageData(img, 0, 0);
  const jpeg = await toBlob(canvas, "image/jpeg", 0.9);
  const idImg = ctx.createImageData(W, H);
  for (let i = 0; i < p.ids.length; i++) {
    idImg.data[i * 4] = p.ids[i];
    idImg.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(idImg, 0, 0);
  const png = await toBlob(canvas, "image/png");
  return { jpeg, png };
}
