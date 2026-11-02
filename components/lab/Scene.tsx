"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { TANK } from "@/lib/sim/constants";
import { mulberry32 } from "@/lib/sim/rng";
import { useSimStore } from "@/lib/sim/store";
import { useMissionStore } from "@/lib/store/mission";
import { Aquarium } from "./Aquarium";
import { CameraRig, INITIAL_CAMERA } from "./CameraRig";
import { Electronics } from "./Electronics";
import { FeedRenderer, feedCam, renderStats } from "./FeedRenderer";
import { Gantry } from "./Gantry";
import { Callouts, Overlays, PlanPath } from "./Overlays";
import { SimDriver } from "./SimDriver";
import { TestObjects } from "./TestObjects";
import { mergeBoxes, std } from "./util";
import { C } from "@/lib/theme";

const FLOOR_Y = -0.85;

/** Procedural environment map so metals and acrylic have something to reflect. No downloads. */
function Env() {
  const gl = useThree((s) => s.gl);
  const tex = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const t = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    return t;
  }, [gl]);
  useFrame(({ scene }) => {
    if (scene.environment !== tex) scene.environment = tex;
    // reflections dim with the lab lighting too, so the slider reads on the metals
    scene.environmentIntensity = 0.35 * (0.08 + 0.92 * useSimStore.getState().engine.scenario.lighting);
  });
  return null;
}

/** Lower-powered devices: phones, tablets and small windows render at a lower ceiling and with a smaller shadow map. */
const LIGHT_DEVICE = typeof window !== "undefined" && (window.innerWidth < 1000 || window.matchMedia("(pointer: coarse)").matches);
const MAX_DPR = LIGHT_DEVICE ? 1.25 : 1.5;

function Lights() {
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const fill = useRef<THREE.PointLight>(null);
  useFrame(() => {
    const l = useSimStore.getState().engine.scenario.lighting;
    const k = 0.08 + 0.92 * l;
    if (sun.current) sun.current.intensity = 0.25 + 1.6 * l;
    if (hemi.current) hemi.current.intensity = 1.0 * k;
    if (fill.current) fill.current.intensity = 2.5 * k;
  });
  return (
    <>
      <directionalLight
        ref={sun}
        position={[1.2, 3.2, 0.9]}
        intensity={1.9}
        color="#f3f0e8"
        castShadow
        shadow-mapSize={LIGHT_DEVICE ? [1024, 1024] : [2048, 2048]}
        shadow-radius={4}
        shadow-bias={-0.0004}
        shadow-normalBias={0.01}
        shadow-camera-left={-1.1}
        shadow-camera-right={1.2}
        shadow-camera-top={0.9}
        shadow-camera-bottom={-0.9}
        shadow-camera-near={0.5}
        shadow-camera-far={7}
      />
      <hemisphereLight ref={hemi} args={["#7fa6b8", C.ground, 0.6]} />
      <pointLight ref={fill} position={[-1.6, 1.4, -1.2]} intensity={2.5} decay={2} color="#c9d6e0" />
    </>
  );
}

/**
 * Room backdrop: a dim radial falloff behind the rig instead of a flat fill, so the tank reads as lit in a dark lab.
 * Screen-space texture; the feed pass swaps the background for its fog colour, so the camera feed is unaffected.
 */
function Backdrop() {
  const tex = useMemo(() => {
    const n = 256;
    const cv = document.createElement("canvas");
    cv.width = cv.height = n;
    const g = cv.getContext("2d")!;
    const grad = g.createRadialGradient(n * 0.5, n * 0.38, 0, n * 0.5, n * 0.45, n * 0.75);
    grad.addColorStop(0, "#132331");
    grad.addColorStop(0.55, "#0b151e");
    grad.addColorStop(1, C.ground);
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
    // a little noise breaks 8-bit banding in the dark ramp
    const img = g.getImageData(0, 0, n, n);
    const rand = mulberry32(11);
    for (let i = 0; i < img.data.length; i += 4) {
      const d = (rand() - 0.5) * 3;
      img.data[i] += d;
      img.data[i + 1] += d;
      img.data[i + 2] += d;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  return <primitive attach="background" object={tex} />;
}

/** Dark lab room: concrete floor with a faint grid and a steel table under the tank. */
function Room() {
  const floorMat = useMemo(() => std({ color: "#151b21", roughness: 0.95, fog: false }), []);
  const steelMat = useMemo(() => std({ color: "#262c33", roughness: 0.6, metalness: 0.5, fog: false }), []);
  const tableGeo = useMemo(() => {
    const top = -TANK.sandDepth - TANK.glass; // glass underside
    const legH = top - 0.04 - FLOOR_Y;
    const parts: Parameters<typeof mergeBoxes>[0] = [{ size: [1.32, 0.04, 0.72], at: [0, top - 0.02, 0] }];
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        parts.push({ size: [0.04, legH, 0.04], at: [sx * 0.62, FLOOR_Y + legH / 2, sz * 0.32] });
      }
    for (const sz of [-1, 1]) parts.push({ size: [1.24, 0.03, 0.03], at: [0, FLOOR_Y + 0.25, sz * 0.32] });
    return mergeBoxes(parts);
  }, []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, 0]} material={floorMat} receiveShadow>
        <planeGeometry args={[14, 14]} />
      </mesh>
      <mesh geometry={tableGeo} material={steelMat} castShadow receiveShadow />
    </group>
  );
}

/** Dev only: lets browser tests drive the store and read draw call counts. */
function DevHooks() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __labStore?: typeof useSimStore; __missionStore?: typeof useMissionStore; __labStats?: typeof renderStats; __labScene?: THREE.Scene; __labFeedCam?: THREE.PerspectiveCamera };
    w.__labStore = useSimStore;
    w.__missionStore = useMissionStore;
    w.__labStats = renderStats;
    w.__labScene = scene;
    w.__labFeedCam = feedCam;
  }, [scene]);
  return null;
}

export function LabScene() {
  // Adaptive quality: if the frame rate cannot hold, drop to 1x pixels for the rest of the session (no flip-flopping).
  const [dpr, setDpr] = useState<[number, number]>([1, MAX_DPR]);
  return (
    <Canvas
      dpr={dpr}
      shadows={{ type: THREE.PCFShadowMap }}
      frameloop="always"
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: 40, near: 0.02, far: 40, position: INITIAL_CAMERA }}
      onPointerMissed={() => useSimStore.getState().selectObject(null)}
    >
      <PerformanceMonitor onDecline={() => setDpr([1, 1])} />
      <Backdrop />
      <SimDriver />
      <CameraRig />
      <Env />
      <Lights />
      <Room />
      <Aquarium />
      <Gantry />
      <Electronics />
      <TestObjects />
      <Overlays />
      <PlanPath />
      <Callouts />
      <FeedRenderer />
      <DevHooks />
    </Canvas>
  );
}
