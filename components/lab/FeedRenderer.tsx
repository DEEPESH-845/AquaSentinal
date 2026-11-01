"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { CAMERA, gantryToWorld } from "@/lib/sim/constants";
import { FEED_ELEMENT_ID, useSimStore } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { CaptureRenderer, encodeCapture } from "./capture";

const CLEAR_FOG = new THREE.Color("#2a6f7a");
const MURKY_FOG = new THREE.Color("#4f5c34");
const DARK_FOG = new THREE.Color("#050807");

/** Live draw call count of the last frame (main pass + feed pass), for profiling. */
export const renderStats = { calls: 0, triangles: 0 };

/**
 * Takes over the render loop: main pass to the full canvas, then the gantry camera
 * rendered into the screen rect of the DOM element with id FEED_ELEMENT_ID.
 * The feed camera matches lib/sim/detection.ts projectToFeed exactly:
 * lens at (wx, lensHeight, wz), looking straight down, up = (0, 0, -1).
 */
export const feedCam = (() => {
  const hfov = (CAMERA.hfovDeg * Math.PI) / 180;
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) / CAMERA.aspect);
  const cam = new THREE.PerspectiveCamera((vfov * 180) / Math.PI, CAMERA.aspect, 0.02, 3);
  cam.up.set(0, 0, -1);
  cam.layers.set(0); // mast and housing live on layer 1 and are excluded
  return cam;
})();
const fog = new THREE.FogExp2(CLEAR_FOG.clone(), 1);
/** Main-pass silt fog. Only underwater materials keep fog enabled, so above-water parts stay crisp. */
const mainFog = new THREE.FogExp2(new THREE.Color("#2f8a93"), 0.15);
const MAIN_CLEAR = new THREE.Color("#2f8a93");
const MAIN_SILT = new THREE.Color("#5c6b3c");

interface FeedRect {
  el: HTMLElement | null;
  rect: DOMRect | null;
  dirty: boolean;
  ro: ResizeObserver | null;
}

/** Feed water: the same colour and density for the live inset and for captured inspection frames. */
function updateFeedFog(t: number, lighting: number) {
  fog.color.lerpColors(CLEAR_FOG, MURKY_FOG, t).lerp(DARK_FOG, 1 - lighting);
  fog.density = 0.6 + 2.4 * t;
}

export function FeedRenderer() {
  const capturer = useRef<CaptureRenderer | null>(null);
  const capturedSeq = useRef(0);
  useEffect(() => () => capturer.current?.dispose(), []);
  // The feed element's rect is cached and refreshed by ResizeObserver, window resize and scroll,
  // plus one re-read on the frame after any change, instead of a layout read every frame.
  const feed = useRef<FeedRect>({ el: null, rect: null, dirty: true, ro: null });

  useEffect(() => {
    const f = feed.current;
    const mark = () => {
      f.rect = f.el?.getBoundingClientRect() ?? null;
      f.dirty = true;
    };
    window.addEventListener("resize", mark);
    window.addEventListener("scroll", mark, true);
    return () => {
      window.removeEventListener("resize", mark);
      window.removeEventListener("scroll", mark, true);
      f.ro?.disconnect();
      f.ro = null;
      f.el = null;
    };
  }, []);

  useFrame((state) => {
    const { gl, scene, camera } = state;
    const pr = gl.getPixelRatio();
    const canvas = gl.domElement;
    const fullW = canvas.clientWidth * pr;
    const fullH = canvas.clientHeight * pr;

    const { turbidity: t, lighting } = useSimStore.getState().engine.scenario;
    mainFog.color.lerpColors(MAIN_CLEAR, MAIN_SILT, t);
    // lower base than the audit suggested: fog is camera distance, and from preset A the sand is 2.6 m away
    mainFog.density = 0.06 + 1.6 * t * t;
    scene.fog = mainFog;

    // Shadow maps are rendered once per frame, in the main pass only.
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
    gl.render(scene, camera);
    renderStats.calls = gl.info.render.calls;
    renderStats.triangles = gl.info.render.triangles;
    updateFeedFog(t, lighting);

    // One pending inspection capture per frame, rendered whether or not the feed panel is on screen.
    const engine = useSimStore.getState().engine;
    const pending = engine.captureQueue.find((c) => c.seq > capturedSeq.current);
    if (pending) {
      capturedSeq.current = pending.seq;
      if (pending.cameraOnline) {
        capturer.current ??= new CaptureRenderer(feedCam);
        const [cx, cz] = gantryToWorld(pending.gantryX, pending.gantryY);
        const pixels = capturer.current.render(gl, scene, [cx, CAMERA.lensHeight, cz], fog, engine.scenario.objects);
        void encodeCapture(pixels).then(({ jpeg, png }) => useMissionStore.getState().submitCapture(pending, jpeg, png, pixels.idMap));
      }
      gl.setViewport(0, 0, fullW, fullH);
    }

    const f = feed.current;
    if (!f.el || !f.el.isConnected) {
      f.ro?.disconnect();
      f.ro = null;
      f.el = document.getElementById(FEED_ELEMENT_ID);
      f.rect = null;
      if (!f.el) return;
      f.ro = new ResizeObserver(() => {
        f.rect = f.el?.getBoundingClientRect() ?? null;
        f.dirty = true;
      });
      f.ro.observe(f.el);
      f.dirty = true;
    }
    if (f.dirty || !f.rect) {
      f.rect = f.el.getBoundingClientRect();
      f.dirty = false;
    }
    const r = f.rect;
    if (r.width < 4 || r.height < 4) return;
    const c = canvas.getBoundingClientRect();
    const x = Math.round((r.left - c.left) * pr);
    const y = Math.round((c.bottom - r.bottom) * pr);
    const w = Math.round(r.width * pr);
    const h = Math.round(r.height * pr);
    if (x + w <= 0 || y + h <= 0 || x >= fullW || y >= fullH) return;

    const g = useSimStore.getState().engine.gantry;
    const [wx, wz] = gantryToWorld(g.x.pos, g.y.pos);
    feedCam.position.set(wx, CAMERA.lensHeight, wz);
    feedCam.lookAt(wx, 0, wz);

    gl.setViewport(x, y, w, h);
    gl.setScissor(x, y, w, h);
    gl.setScissorTest(true);
    // A Color background forces a clear inside the scissor rect, so swap it for the fog colour.
    const bg = scene.background;
    scene.background = fog.color;
    scene.fog = fog;
    gl.autoClear = false;
    gl.clear(true, true, false);
    gl.render(scene, feedCam);
    renderStats.calls += gl.info.render.calls;
    renderStats.triangles += gl.info.render.triangles;
    scene.background = bg;
    scene.fog = mainFog;
    gl.autoClear = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
  }, 1);

  return null;
}
