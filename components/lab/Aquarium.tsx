"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { GANTRY, TANK } from "@/lib/sim/constants";
import { mulberry32 } from "@/lib/sim/rng";
import { useSimStore } from "@/lib/sim/store";
import { mergeBoxes, std, useHighlight } from "./util";

const L = TANK.length;
const W = TANK.width;
const G = TANK.glass;
const SD = TANK.sandDepth;
const WL = TANK.waterLevel;
const RIM = GANTRY.frameHeight;
const BOTTOM = -SD - G; // world Y of the glass underside
const WALL_H = RIM - BOTTOM;
const INNER_L = L - 2 * G;
const INNER_W = W - 2 * G;

const CLEAR_WATER = new THREE.Color("#2f8a93");
const MURKY_WATER = new THREE.Color("#5c6b3c");
const CLEAR_SAND_TINT = new THREE.Color(0.86, 0.9, 0.9);
const MURKY_SAND_TINT = new THREE.Color(0.62, 0.66, 0.5);

/* ---------- sand ---------- */

function buildSandGeometry() {
  const geo = new THREE.PlaneGeometry(INNER_L, INNER_W, 120, 60);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rand = mulberry32(7);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // fade ripples out over the last 6 cm so the edge meets the sand box cleanly
    const ex = Math.min(1, (INNER_L / 2 - Math.abs(x)) / 0.06);
    const ez = Math.min(1, (INNER_W / 2 - Math.abs(z)) / 0.06);
    const fade = Math.max(0, Math.min(ex, ez));
    const r1 = 0.005 * Math.sin((x * 0.7 + z) * 9 + 0.4);
    const r2 = 0.004 * Math.sin((x - z * 0.5) * 13 + 1.1);
    const grain = (rand() - 0.5) * 0.0012;
    pos.setY(i, (r1 + r2) * fade + grain);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeSandMaterial() {
  const uniforms = {
    uTime: { value: 0 },
    uCaustic: { value: 0.5 },
    uTint: { value: CLEAR_SAND_TINT.clone() },
  };
  const mat = std({ color: "#8f7d5c", roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vSandXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSandXZ = vec2(position.x, position.z);");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec2 vSandXZ;
        uniform float uTime;
        uniform float uCaustic;
        uniform vec3 uTint;
        float caustic(vec2 p, float t) {
          return sin(p.x + t * 0.9) * sin(p.y * 1.3 - t * 0.7)
               + sin((p.x + p.y) * 0.7 + t * 0.5) * sin((p.x - p.y) * 0.9 - t * 0.8);
        }`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float grain = fract(sin(dot(floor(vSandXZ * 900.0), vec2(12.9898, 78.233))) * 43758.5453);
        diffuseColor.rgb *= 0.93 + 0.1 * grain;
        vec2 p = vSandXZ * 70.0;
        float c = caustic(p, uTime) + 0.5 * caustic(p * 2.1 + 3.0, uTime * 1.3);
        c = pow(max(0.0, c * 0.5), 4.0);
        diffuseColor.rgb += uCaustic * c * vec3(0.95, 0.97, 0.9);
        diffuseColor.rgb *= uTint;`,
      );
  };
  mat.customProgramCacheKey = () => "gantrylab-sand";
  return { mat, uniforms };
}

/* ---------- water surface ---------- */

const SURFACE_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vec3 p = position;
  float t = uTime;
  float h = 0.0015 * sin(p.x * 9.0 + t * 0.8) + 0.001 * sin(p.y * 13.0 - t * 0.6) + 0.0008 * sin((p.x + p.y) * 21.0 + t * 1.1);
  float dhx = 0.0135 * cos(p.x * 9.0 + t * 0.8) + 0.0168 * cos((p.x + p.y) * 21.0 + t * 1.1);
  float dhy = 0.013 * cos(p.y * 13.0 - t * 0.6) + 0.0168 * cos((p.x + p.y) * 21.0 + t * 1.1);
  p.z += h;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  // plane local +z is world +y, local x -> world x, local y -> world -z
  vNormalW = normalize(vec3(-dhx, 1.0, dhy));
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SURFACE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uLight;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vNormalW);
  float ndv = dot(n, v);
  vec3 col;
  float a;
  if (ndv < 0.0) {
    // underside: total internal reflection reads as a silvery mirror at grazing angles
    n = -n;
    float f = pow(1.0 - max(-ndv, 0.0), 2.0);
    col = mix(uColor, vec3(0.75, 0.82, 0.84), f * 0.8);
    a = uOpacity + f * 0.55;
  } else {
    float f = pow(1.0 - max(ndv, 0.0), 3.0);
    vec3 r = reflect(-v, n);
    // elongated ceiling-light reflections instead of one point highlight
    float lights = smoothstep(0.85, 0.99, r.y) * (0.5 + 0.5 * sin(r.x * 40.0)) * uLight * 0.35;
    col = mix(uColor, vec3(0.62, 0.72, 0.76), f * 0.45) + lights;
    a = uOpacity + f * 0.3 + lights * 0.6;
  }
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.9));
}`;

/* ---------- particles ---------- */

const PARTICLE_VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
attribute float seed;
void main() {
  vec3 p = position;
  p.x += 0.012 * sin(uTime * 0.25 + seed * 6.28);
  p.z += 0.010 * cos(uTime * 0.21 + seed * 9.4);
  p.y += 0.008 * sin(uTime * 0.17 + seed * 3.1);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(uSize * uPixelRatio * (0.6 / -mv.z), 1.0, 4.0 * uPixelRatio);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform float uOpacity;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  gl_FragColor = vec4(0.85, 0.9, 0.88, uOpacity);
}`;

function buildParticles(count: number) {
  const rand = mulberry32(99);
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (rand() - 0.5) * (INNER_L - 0.04);
    pos[i * 3 + 1] = 0.02 + rand() * (WL - 0.04);
    pos[i * 3 + 2] = (rand() - 0.5) * (INNER_W - 0.04);
    seed[i] = rand();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
  return geo;
}

/* ---------- component ---------- */

export function Aquarium() {
  const { glassMat, trimMat, meniscusMat, meniscus, waterMat, surfaceMat, particleMat, sand, seams, particles, update } = useMemo(() => {
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: "#bcd8dd",
      transparent: true,
      opacity: 0.16,
      roughness: 0.05,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.6,
      depthWrite: false,
      fog: false,
    });
    const trimMat = std({ color: "#15181b", roughness: 0.7, fog: false });
    const meniscusMat = new THREE.MeshBasicMaterial({ color: "#dfe9ec", transparent: true, opacity: 0.55, fog: false, depthWrite: false });
    const meniscus = mergeBoxes([
      { size: [INNER_L, 0.002, 0.002], at: [0, WL, INNER_W / 2 - 0.001] },
      { size: [INNER_L, 0.002, 0.002], at: [0, WL, -INNER_W / 2 + 0.001] },
      { size: [0.002, 0.002, INNER_W], at: [INNER_L / 2 - 0.001, WL, 0] },
      { size: [0.002, 0.002, INNER_W], at: [-INNER_L / 2 + 0.001, WL, 0] },
    ]);
    const waterMat = new THREE.MeshStandardMaterial({
      color: CLEAR_WATER.clone(),
      transparent: true,
      opacity: 0.18,
      roughness: 1,
      metalness: 0,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const surfaceMat = new THREE.ShaderMaterial({
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: CLEAR_WATER.clone() },
        uOpacity: { value: 0.3 },
        uLight: { value: 0.8 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const particleMat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uOpacity: { value: 0.3 }, uSize: { value: 2.2 } },
      transparent: true,
      depthWrite: false,
    });
    const seamH = WALL_H;
    const seamY = BOTTOM + seamH / 2;
    const cx = L / 2 - G / 2;
    const cz = W / 2 - G / 2;
    const seams = mergeBoxes([
      // vertical silicone seams
      { size: [0.014, seamH, 0.014], at: [cx, seamY, cz] },
      { size: [0.014, seamH, 0.014], at: [-cx, seamY, cz] },
      { size: [0.014, seamH, 0.014], at: [cx, seamY, -cz] },
      { size: [0.014, seamH, 0.014], at: [-cx, seamY, -cz] },
      // bottom seams
      { size: [L, 0.014, 0.014], at: [0, BOTTOM + G, cz] },
      { size: [L, 0.014, 0.014], at: [0, BOTTOM + G, -cz] },
      { size: [0.014, 0.014, W], at: [cx, BOTTOM + G, 0] },
      { size: [0.014, 0.014, W], at: [-cx, BOTTOM + G, 0] },
      // rim trim
      { size: [L + 0.02, 0.014, 0.024], at: [0, RIM, cz] },
      { size: [L + 0.02, 0.014, 0.024], at: [0, RIM, -cz] },
      { size: [0.024, 0.014, W + 0.02], at: [cx, RIM, 0] },
      { size: [0.024, 0.014, W + 0.02], at: [-cx, RIM, 0] },
    ]);
    const sand = { geo: buildSandGeometry(), ...makeSandMaterial() };
    // phones and small screens get a lighter cloud
    const particleCount = typeof window !== "undefined" && (window.innerWidth < 1000 || window.matchMedia("(pointer: coarse)").matches) ? 700 : 1600;
    const particles = buildParticles(particleCount);
    /** Per-frame uniform and material updates, driven by the scenario. */
    const update = (t: number, turbidity: number, lighting: number, pixelRatio: number) => {
      sand.uniforms.uTime.value = t;
      sand.uniforms.uCaustic.value = 0.35 * lighting * (1 - 0.8 * turbidity);
      sand.uniforms.uTint.value.lerpColors(CLEAR_SAND_TINT, MURKY_SAND_TINT, turbidity);
      waterMat.color.lerpColors(CLEAR_WATER, MURKY_WATER, turbidity);
      waterMat.opacity = 0.08 + 0.5 * turbidity;
      surfaceMat.uniforms.uTime.value = t;
      surfaceMat.uniforms.uColor.value.lerpColors(CLEAR_WATER, MURKY_WATER, turbidity);
      surfaceMat.uniforms.uOpacity.value = 0.12 + 0.45 * turbidity;
      surfaceMat.uniforms.uLight.value = lighting;
      particleMat.uniforms.uTime.value = t;
      particleMat.uniforms.uPixelRatio.value = pixelRatio;
      particleMat.uniforms.uOpacity.value = 0.2 + 0.35 * turbidity;
      // silt is more particles, not just brighter ones: a quarter of the cloud in clear water, all of it at full turbidity
      particleMat.uniforms.uSize.value = 2.0 + 0.8 * turbidity;
      particles.setDrawRange(0, Math.round(particleCount * (0.25 + 0.75 * turbidity)));
    };
    return {
      glassMat,
      trimMat,
      meniscusMat,
      meniscus,
      waterMat,
      surfaceMat,
      particleMat,
      sand,
      seams,
      particles,
      update,
    };
  }, []);

  useHighlight("aquarium", [glassMat, trimMat]);

  useFrame((state) => {
    const { turbidity, lighting } = useSimStore.getState().engine.scenario;
    update(state.clock.elapsedTime, turbidity, lighting, state.gl.getPixelRatio());
  });

  return (
    <group>
      {/* sand: rippled surface plus a shallow layer visible through the glass */}
      <mesh geometry={sand.geo} material={sand.mat} receiveShadow />
      <mesh position={[0, -SD / 2 - 0.003, 0]} material={sand.mat}>
        <boxGeometry args={[INNER_L, SD - 0.006, INNER_W]} />
      </mesh>

      {/* water volume, BackSide so a camera inside it sees the tint on the walls */}
      <mesh position={[0, (WL - 0.006) / 2, 0]} material={waterMat} renderOrder={1}>
        <boxGeometry args={[INNER_L, WL + 0.006, INNER_W]} />
      </mesh>
      <mesh position={[0, WL, 0]} rotation={[-Math.PI / 2, 0, 0]} material={surfaceMat} renderOrder={2}>
        <planeGeometry args={[INNER_L, INNER_W, 48, 24]} />
      </mesh>
      <points geometry={particles} material={particleMat} renderOrder={2} />

      {/* glass: four walls and the bottom pane */}
      <group renderOrder={3}>
        <mesh position={[0, BOTTOM + WALL_H / 2, W / 2 - G / 2]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[L, WALL_H, G]} />
        </mesh>
        <mesh position={[0, BOTTOM + WALL_H / 2, -W / 2 + G / 2]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[L, WALL_H, G]} />
        </mesh>
        <mesh position={[L / 2 - G / 2, BOTTOM + WALL_H / 2, 0]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[G, WALL_H, W - 2 * G]} />
        </mesh>
        <mesh position={[-L / 2 + G / 2, BOTTOM + WALL_H / 2, 0]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[G, WALL_H, W - 2 * G]} />
        </mesh>
        <mesh position={[0, BOTTOM + G / 2, 0]} material={glassMat} renderOrder={3}>
          <boxGeometry args={[L - 2 * G, G, W - 2 * G]} />
        </mesh>
      </group>

      {/* silicone seams, rim trim, meniscus line at the fill level */}
      <mesh geometry={seams} material={trimMat} />
      <mesh geometry={meniscus} material={meniscusMat} renderOrder={3} />
    </group>
  );
}
