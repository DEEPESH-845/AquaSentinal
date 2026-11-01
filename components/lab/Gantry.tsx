"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CAMERA, GANTRY, TANK, gantryToWorld } from "@/lib/sim/constants";
import { useSimStore } from "@/lib/sim/store";
import { mergeBoxes, std, useHighlight } from "./util";

/* ---------- layout (world metres) ---------- */

const RIM = GANTRY.frameHeight; // 0.60 tank rim
const FRAME_Y = GANTRY.railHeight + 0.01; // 2020 frame centre line, bottom at railHeight
const POST_X = TANK.length / 2 - 0.01;
const POST_Z = TANK.width / 2 - 0.01;
const FRAME_HALF_L = 0.64;
const FRAME_HALF_W = 0.30;
const RAIL_Z = 0.29; // X rails (MGN12) on top of the long members
const RAIL_Y = GANTRY.railHeight + 0.02 + 0.004; // rail centre, sits on the extrusion top
const BLOCK_Y = GANTRY.railHeight + 0.02 + 0.0065; // rail block centre (13 mm tall)
const BEAM_Y = BLOCK_Y + 0.0065 + 0.02; // 2040 beam centre, bottom on the blocks
const BEAM_HALF = 0.305; // ends just past the rail blocks, clear of the X cable chain
const BELT_Z = RAIL_Z - 0.028; // X belts run on the inner side of each rail
const BELT_Y = BLOCK_Y - 0.004; // both runs clear the beam bottom (0.733) and the frame top (0.72)
const PULLEY_R = 0.00636; // GT2 20T pitch radius
const SHAFT_R = 0.0025; // 5 mm cross shaft
const X_DRIVE_X = 0.635;
const X_IDLER_X = -0.61;
const X_MOTOR_Z = 0.34; // outboard of the +Z long member
const SHAFT_HALF = 0.3;
/**
 * The carriage hangs on the +X face of the beam: MGN12 rail (8 mm) wrapped by its block
 * (13 mm total), then the 6 mm plate, then the 2020 mast. Beam centre = mast X + BEAM_OFFSET_X.
 */
export const BEAM_OFFSET_X = -0.039;
const Y_RAIL_X = 0.014;
const Y_BLOCK_X = 0.0165;
const PLATE_X = 0.026;
const MAST_X = -BEAM_OFFSET_X;
const MAST_TOP = 0.79;
const MAST_LEN = 0.25;
const HOUSING_R = 0.03;
const HOUSING_H = 0.1;
const HOUSING_TOP = CAMERA.lensHeight + HOUSING_H;
const Y_BELT_Y = 0.03; // above beam top, relative to beam centre
const Y_BELT_X = 0.034; // outboard of the plate face (0.029)
const CHAIN_LINKS = 34;
const CHAIN_LINK_LEN = 0.018;
const CHAIN_R = 0.045;
const CHAIN_X = -0.014;
const CHAIN_Y0 = 0.02 + 0.012; // lower run centre above beam top, relative to beam centre
const CHAIN_FIXED_Z = 0.29;
const CHAIN_LEN = CHAIN_LINKS * CHAIN_LINK_LEN;
// X cable chain: outside the +Z long member, fixed at the drive end, moving end on the beam.
const XCHAIN_LINKS = 72;
const XCHAIN_Z = 0.318;
const XCHAIN_Y0 = GANTRY.railHeight + 0.011; // lower run beside the member
const XCHAIN_FIXED_X = 0.6;
const XCHAIN_LEN = XCHAIN_LINKS * CHAIN_LINK_LEN;

/* ---------- small parts ---------- */

function Nema17({ mats, position, rotation }: { mats: Mats; position: [number, number, number]; rotation?: [number, number, number] }) {
  // Body 42 mm cube, boss and shaft on local +Z. Rotate the group to aim the shaft.
  return (
    <group position={position} rotation={rotation}>
      <mesh material={mats.motor} castShadow>
        <boxGeometry args={[0.042, 0.042, 0.042]} />
      </mesh>
      <mesh material={mats.rail} position={[0, 0, 0.022]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.011, 0.011, 0.004, 20]} />
      </mesh>
      <mesh material={mats.rail} position={[0, 0, 0.032]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.0025, 0.0025, 0.024, 10]} />
      </mesh>
      {/* label plate */}
      <mesh material={mats.label} position={[0.0215, 0.004, 0]}>
        <boxGeometry args={[0.0006, 0.016, 0.028]} />
      </mesh>
    </group>
  );
}

/** GT2 pulley or idler: flanged disc with a radial mark so rotation reads. Shaft along local Z. */
function Pulley({ mats, position, radius = PULLEY_R, groupRef, flanged = true }: { mats: Mats; position: [number, number, number]; radius?: number; groupRef: React.RefObject<THREE.Group | null>; flanged?: boolean }) {
  return (
    <group ref={groupRef} position={position}>
      <mesh material={mats.rail} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[radius, radius, 0.009, 16]} />
      </mesh>
      {flanged && (
        <mesh material={mats.rail} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[radius + 0.0025, radius + 0.0025, 0.0012, 16]} />
        </mesh>
      )}
      <mesh material={mats.black} position={[radius * 0.55, 0, 0]}>
        <boxGeometry args={[radius * 0.9, 0.0025, 0.011]} />
      </mesh>
    </group>
  );
}

function LimitSwitch({ mats, position, rotation }: { mats: Mats; position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <group position={position} rotation={rotation}>
      <mesh material={mats.black}>
        <boxGeometry args={[0.02, 0.01, 0.006]} />
      </mesh>
      <mesh material={mats.rail} position={[0.008, 0.008, 0]} rotation={[0, 0, 0.5]}>
        <boxGeometry args={[0.018, 0.0008, 0.008]} />
      </mesh>
    </group>
  );
}

interface Mats {
  alu: THREE.MeshStandardMaterial;
  black: THREE.MeshStandardMaterial;
  motor: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
  belt: THREE.MeshStandardMaterial;
  label: THREE.MeshStandardMaterial;
  chain: THREE.MeshStandardMaterial;
}

/* ---------- component ---------- */

export function Gantry() {
  const mats = useMemo<Mats>(
    () => ({
      alu: std({ color: "#767b82", metalness: 0.6, roughness: 0.5, fog: false }),
      black: std({ color: "#141516", roughness: 0.85, fog: false }),
      motor: std({ color: "#1c1d1f", roughness: 0.6, metalness: 0.3, fog: false }),
      rail: std({ color: "#8a8e93", metalness: 0.7, roughness: 0.5, fog: false }),
      belt: std({ color: "#101010", roughness: 0.95, fog: false }),
      label: std({ color: "#cfd3d6", roughness: 0.4, metalness: 0.5, fog: false }),
      chain: std({ color: "#2a2d30", roughness: 0.75, fog: false }),
    }),
    [],
  );
  const camMats = useMemo(
    () => ({
      acrylic: new THREE.MeshPhysicalMaterial({
        color: "#d7e6ea",
        transparent: true,
        opacity: 0.28,
        roughness: 0.08,
        clearcoat: 1,
        depthWrite: false,
      }),
      cap: std({ color: "#111214", roughness: 0.7 }),
      pcb: std({ color: "#2f6b3d", roughness: 0.6 }),
    }),
    [],
  );
  useHighlight("gantry", [mats.alu, mats.black, mats.motor, mats.rail, mats.chain]);
  useHighlight("camera", [camMats.acrylic, camMats.cap, camMats.pcb], 0.5);

  const frameGeo = useMemo(() => {
    const postH = GANTRY.railHeight - RIM;
    const parts: Parameters<typeof mergeBoxes>[0] = [
      // long members (X) and short members (Z)
      { size: [FRAME_HALF_L * 2, 0.02, 0.02], at: [0, FRAME_Y, RAIL_Z] },
      { size: [FRAME_HALF_L * 2, 0.02, 0.02], at: [0, FRAME_Y, -RAIL_Z] },
      { size: [0.02, 0.02, FRAME_HALF_W * 2], at: [FRAME_HALF_L - 0.01, FRAME_Y, 0] },
      { size: [0.02, 0.02, FRAME_HALF_W * 2], at: [-FRAME_HALF_L + 0.01, FRAME_Y, 0] },
    ];
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        parts.push({ size: [0.02, postH, 0.02], at: [sx * POST_X, RIM + postH / 2, sz * POST_Z] });
        parts.push({ size: [0.05, 0.004, 0.05], at: [sx * POST_X, RIM + 0.002, sz * POST_Z] });
      }
    // X chain tray: angle bolted to the outer face of the +Z long member
    parts.push({ size: [1.2, 0.003, 0.03], at: [0.0, GANTRY.railHeight - 0.0015, XCHAIN_Z] });
    parts.push({ size: [1.2, 0.024, 0.002], at: [0.0, GANTRY.railHeight + 0.011, FRAME_HALF_W + 0.001] });
    return mergeBoxes(parts);
  }, []);

  const railGeo = useMemo(
    () =>
      mergeBoxes([
        { size: [1.2, 0.008, 0.012], at: [0, RAIL_Y, RAIL_Z] },
        { size: [1.2, 0.008, 0.012], at: [0, RAIL_Y, -RAIL_Z] },
        // cross shaft pillow blocks and X idler posts, on top of the long members
        { size: [0.016, 0.009, 0.014], at: [X_DRIVE_X, GANTRY.railHeight + 0.0245, RAIL_Z] },
        { size: [0.016, 0.009, 0.014], at: [X_DRIVE_X, GANTRY.railHeight + 0.0245, -RAIL_Z] },
        { size: [0.016, 0.009, 0.014], at: [X_IDLER_X, GANTRY.railHeight + 0.0245, RAIL_Z] },
        { size: [0.016, 0.009, 0.014], at: [X_IDLER_X, GANTRY.railHeight + 0.0245, -RAIL_Z] },
        // X motor plate under the member, motor body outboard
        { size: [0.05, 0.004, 0.09], at: [X_DRIVE_X, GANTRY.railHeight - 0.0005, 0.325] },
      ]),
    [],
  );

  const beltGeo = useMemo(() => {
    const len = X_DRIVE_X - X_IDLER_X;
    const cx = (X_DRIVE_X + X_IDLER_X) / 2;
    const parts: Parameters<typeof mergeBoxes>[0] = [];
    for (const sz of [-1, 1]) {
      parts.push({ size: [len, 0.0015, 0.006], at: [cx, BELT_Y + PULLEY_R, sz * BELT_Z] });
      parts.push({ size: [len, 0.0015, 0.006], at: [cx, BELT_Y - PULLEY_R, sz * BELT_Z] });
    }
    return mergeBoxes(parts);
  }, []);

  const beamStaticGeo = useMemo(
    () =>
      mergeBoxes([
        // 2040 beam spanning Z
        { size: [0.02, 0.04, BEAM_HALF * 2], at: [0, 0, 0] },
        // rail blocks under each end, on the X rails
        { size: [0.045, 0.013, 0.027], at: [0, -0.02 - 0.0065, RAIL_Z] },
        { size: [0.045, 0.013, 0.027], at: [0, -0.02 - 0.0065, -RAIL_Z] },
        // belt clamps under the beam: the top X belt run terminates in them
        { size: [0.03, 0.008, 0.014], at: [0, BELT_Y + PULLEY_R - BEAM_Y, BELT_Z] },
        { size: [0.03, 0.008, 0.014], at: [0, BELT_Y + PULLEY_R - BEAM_Y, -BELT_Z] },
        // Y idler L bracket: foot on the beam top, upright on the +X face, pulley outside it
        { size: [0.02, 0.004, 0.02], at: [0, 0.022, BEAM_HALF - 0.03] },
        { size: [0.004, 0.024, 0.02], at: [0.012, 0.028, BEAM_HALF - 0.03] },
        // Y chain tray on the -X side, X chain bracket off the +Z end
        { size: [0.03, 0.003, BEAM_HALF - 0.02], at: [CHAIN_X, 0.02 + 0.0015, (BEAM_HALF - 0.02) / 2 + 0.01] },
        { size: [0.02, 0.008, 0.035], at: [0, XCHAIN_Y0 + 2 * CHAIN_R - BEAM_Y, BEAM_HALF + 0.0075] },
        { size: [0.01, XCHAIN_Y0 + 2 * CHAIN_R - BEAM_Y - 0.024, 0.01], at: [0, (XCHAIN_Y0 + 2 * CHAIN_R - BEAM_Y + 0.02) / 2, BEAM_HALF - 0.005] },
        // Y home switch bracket along the +X face, from under the motor to the plate's home edge
        { size: [0.03, 0.006, 0.04], at: [0.025, -0.011, -0.28] },
      ]),
    [],
  );

  // Open chain links: two side plates and a top cross bar, long axis along the run direction.
  const linkGeo = useMemo(
    () => ({
      z: mergeBoxes([
        { size: [0.003, 0.02, CHAIN_LINK_LEN - 0.002], at: [0.011, 0, 0] },
        { size: [0.003, 0.02, CHAIN_LINK_LEN - 0.002], at: [-0.011, 0, 0] },
        { size: [0.022, 0.003, 0.006], at: [0, 0.0085, 0] },
      ]),
      x: mergeBoxes([
        { size: [CHAIN_LINK_LEN - 0.002, 0.02, 0.003], at: [0, 0, 0.011] },
        { size: [CHAIN_LINK_LEN - 0.002, 0.02, 0.003], at: [0, 0, -0.011] },
        { size: [0.006, 0.003, 0.022], at: [0, 0.0085, 0] },
      ]),
    }),
    [],
  );

  const beamRef = useRef<THREE.Group>(null);
  const carriageRef = useRef<THREE.Group>(null);
  const xPulleyA = useRef<THREE.Group>(null);
  const xPulleyB = useRef<THREE.Group>(null);
  const xIdlerA = useRef<THREE.Group>(null);
  const xIdlerB = useRef<THREE.Group>(null);
  const yPulley = useRef<THREE.Group>(null);
  const yIdler = useRef<THREE.Group>(null);
  const chainRef = useRef<THREE.InstancedMesh>(null);
  const xChainRef = useRef<THREE.InstancedMesh>(null);
  const layer1 = useRef<THREE.Object3D[]>([]);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(1, 1, 1), e: new THREE.Euler() }), []);

  useEffect(() => {
    for (const o of layer1.current) o.layers.set(1);
  }, []);

  useFrame(() => {
    const g = useSimStore.getState().engine.gantry;
    const [wx, wz] = gantryToWorld(g.x.pos, g.y.pos);
    if (beamRef.current) beamRef.current.position.x = wx + BEAM_OFFSET_X;
    if (carriageRef.current) carriageRef.current.position.z = wz;

    // Beam clamped to the top belt run: +X motion turns the +X pulleys clockwise seen from +Z.
    const ax = -(wx + 0.5) / PULLEY_R;
    for (const r of [xPulleyA, xPulleyB, xIdlerA, xIdlerB]) if (r.current) r.current.rotation.z = ax;
    // Carriage clamped to the top Y belt run: +Z motion is a positive turn about X.
    const az = (wz + 0.2) / PULLEY_R;
    // Y pulleys sit in a group turned 90 degrees, so their local Z is world X.
    if (yPulley.current) yPulley.current.rotation.z = az;
    if (yIdler.current) yIdler.current.rotation.z = az;

    // Cable chain: fixed end at the +Z beam end, moving end above the carriage.
    const chain = chainRef.current;
    if (chain) {
      const zB = wz + 0.05;
      const d = CHAIN_FIXED_Z - zB;
      const lower = (CHAIN_LEN + d - Math.PI * CHAIN_R) / 2;
      const zm = CHAIN_FIXED_Z - lower;
      for (let i = 0; i < CHAIN_LINKS; i++) {
        const s = (i + 0.5) * CHAIN_LINK_LEN;
        let z: number, y: number, rx: number;
        if (s < lower) {
          z = CHAIN_FIXED_Z - s;
          y = CHAIN_Y0;
          rx = 0;
        } else if (s < lower + Math.PI * CHAIN_R) {
          const th = (s - lower) / CHAIN_R;
          z = zm - CHAIN_R * Math.sin(th);
          y = CHAIN_Y0 + CHAIN_R - CHAIN_R * Math.cos(th);
          rx = th;
        } else {
          z = zm + (s - lower - Math.PI * CHAIN_R);
          y = CHAIN_Y0 + 2 * CHAIN_R;
          rx = 0;
        }
        tmp.p.set(CHAIN_X, y, z);
        tmp.q.setFromEuler(tmp.e.set(rx, 0, 0));
        tmp.m.compose(tmp.p, tmp.q, tmp.s);
        chain.setMatrixAt(i, tmp.m);
      }
      chain.instanceMatrix.needsUpdate = true;
    }

    // X cable chain: fixed end at the drive corner, moving end on the beam's +Z end bracket.
    const xchain = xChainRef.current;
    if (xchain) {
      const xB = wx + BEAM_OFFSET_X;
      const d = XCHAIN_FIXED_X - xB;
      const lower = (XCHAIN_LEN + d - Math.PI * CHAIN_R) / 2;
      const xm = XCHAIN_FIXED_X - lower;
      for (let i = 0; i < XCHAIN_LINKS; i++) {
        const s = (i + 0.5) * CHAIN_LINK_LEN;
        let x: number, y: number, rz: number;
        if (s < lower) {
          x = XCHAIN_FIXED_X - s;
          y = XCHAIN_Y0;
          rz = 0;
        } else if (s < lower + Math.PI * CHAIN_R) {
          const th = (s - lower) / CHAIN_R;
          x = xm - CHAIN_R * Math.sin(th);
          y = XCHAIN_Y0 + CHAIN_R - CHAIN_R * Math.cos(th);
          rz = -th;
        } else {
          x = xm + (s - lower - Math.PI * CHAIN_R);
          y = XCHAIN_Y0 + 2 * CHAIN_R;
          rz = 0;
        }
        tmp.p.set(x, y, XCHAIN_Z);
        tmp.q.setFromEuler(tmp.e.set(0, 0, rz));
        tmp.m.compose(tmp.p, tmp.q, tmp.s);
        xchain.setMatrixAt(i, tmp.m);
      }
      xchain.instanceMatrix.needsUpdate = true;
    }
  });

  const addLayer1 = (o: THREE.Object3D | null) => {
    if (o && !layer1.current.includes(o)) layer1.current.push(o);
  };

  return (
    <group>
      {/* static frame on the tank rim */}
      <mesh geometry={frameGeo} material={mats.alu} castShadow />
      <mesh geometry={railGeo} material={mats.rail} />
      <mesh geometry={beltGeo} material={mats.belt} />

      {/* X drive: motor outboard at the electronics end, coupler, cross shaft in pillow blocks, idlers at -X */}
      <Nema17 mats={mats} position={[X_DRIVE_X, BELT_Y, X_MOTOR_Z]} rotation={[Math.PI, 0, 0]} />
      <mesh material={mats.black} position={[X_DRIVE_X, BELT_Y, SHAFT_HALF + 0.008]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.006, 0.006, 0.02, 12]} />
      </mesh>
      <mesh material={mats.rail} position={[X_DRIVE_X, BELT_Y, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[SHAFT_R, SHAFT_R, SHAFT_HALF * 2, 10]} />
      </mesh>
      <mesh material={mats.rail} position={[X_IDLER_X, BELT_Y, RAIL_Z - 0.017]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[SHAFT_R, SHAFT_R, 0.04, 10]} />
      </mesh>
      <mesh material={mats.rail} position={[X_IDLER_X, BELT_Y, -RAIL_Z + 0.017]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[SHAFT_R, SHAFT_R, 0.04, 10]} />
      </mesh>
      <Pulley mats={mats} groupRef={xPulleyA} position={[X_DRIVE_X, BELT_Y, BELT_Z]} />
      <Pulley mats={mats} groupRef={xPulleyB} position={[X_DRIVE_X, BELT_Y, -BELT_Z]} />
      <Pulley mats={mats} groupRef={xIdlerA} position={[X_IDLER_X, BELT_Y, BELT_Z]} />
      <Pulley mats={mats} groupRef={xIdlerB} position={[X_IDLER_X, BELT_Y, -BELT_Z]} />
      {/* X home switch on a plate against the member's inner face, lever touching the rail block face at home */}
      <mesh material={mats.black} position={[-0.5 + BEAM_OFFSET_X - 0.0385, GANTRY.railHeight + 0.027, RAIL_Z - 0.012]}>
        <boxGeometry args={[0.02, 0.014, 0.004]} />
      </mesh>
      <LimitSwitch mats={mats} position={[-0.5 + BEAM_OFFSET_X - 0.0385, GANTRY.railHeight + 0.027, RAIL_Z - 0.0155]} />

      {/* X cable chain along the outside of the +Z member */}
      <instancedMesh ref={xChainRef} args={[linkGeo.x, mats.chain, XCHAIN_LINKS]} frustumCulled={false} />

      {/* Y beam: rides the X rails, moves in world X */}
      <group ref={beamRef} position={[BEAM_OFFSET_X, BEAM_Y, 0]}>
        <mesh geometry={beamStaticGeo} material={mats.alu} castShadow />
        {/* MGN12 Y rail on the +X face */}
        <mesh material={mats.rail} position={[Y_RAIL_X, 0, 0]}>
          <boxGeometry args={[0.008, 0.012, 0.6]} />
        </mesh>
        {/* Y drive on the beam top: motor at -Z (shaft +X), idler at +Z on its L bracket, belt along the top */}
        <Nema17 mats={mats} position={[0, 0.02 + 0.021, -BEAM_HALF + 0.03]} rotation={[0, Math.PI / 2, 0]} />
        <mesh material={mats.rail} position={[0.026, Y_BELT_Y, BEAM_HALF - 0.03]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[SHAFT_R, SHAFT_R, 0.024, 10]} />
        </mesh>
        {/* Y motor wire along the beam top into the Y chain */}
        <mesh material={mats.chain} position={[-0.012, 0.0225, 0.01]}>
          <boxGeometry args={[0.004, 0.004, BEAM_HALF * 2 - 0.05]} />
        </mesh>
        <group rotation={[0, Math.PI / 2, 0]} position={[Y_BELT_X, Y_BELT_Y, -BEAM_HALF + 0.03]}>
          <Pulley mats={mats} groupRef={yPulley} position={[0, 0, 0]} />
        </group>
        <group rotation={[0, Math.PI / 2, 0]} position={[Y_BELT_X, Y_BELT_Y, BEAM_HALF - 0.03]}>
          <Pulley mats={mats} groupRef={yIdler} position={[0, 0, 0]} />
        </group>
        <mesh material={mats.belt} position={[Y_BELT_X, Y_BELT_Y + PULLEY_R, 0]}>
          <boxGeometry args={[0.006, 0.0015, BEAM_HALF * 2 - 0.06]} />
        </mesh>
        <mesh material={mats.belt} position={[Y_BELT_X, Y_BELT_Y - PULLEY_R, 0]}>
          <boxGeometry args={[0.006, 0.0015, BEAM_HALF * 2 - 0.06]} />
        </mesh>
        {/* Y home switch on the bracket at plate height; the plate's -Z edge (z = -0.25 at home) hits the lever */}
        <LimitSwitch mats={mats} position={[PLATE_X, -0.003, -0.266]} rotation={[0, -Math.PI / 2, 0]} />

        {/* cable chain, one instanced mesh */}
        <instancedMesh ref={chainRef} args={[linkGeo.z, mats.chain, CHAIN_LINKS]} frustumCulled={false} />

        {/* carriage: rail block, plate, chain bracket, mast, housing. Moves in world Z. */}
        <group ref={carriageRef}>
          <mesh material={mats.black} position={[Y_BLOCK_X, 0, 0]}>
            <boxGeometry args={[0.013, 0.027, 0.045]} />
          </mesh>
          <mesh material={mats.alu} position={[PLATE_X, 0, 0]} castShadow>
            <boxGeometry args={[0.006, 0.09, 0.1]} />
          </mesh>
          {/* belt clamp from the plate face over the top run only, and the chain arm across the beam */}
          <mesh material={mats.black} position={[PLATE_X + 0.003 + 0.006, Y_BELT_Y + PULLEY_R, 0]}>
            <boxGeometry args={[0.012, 0.008, 0.024]} />
          </mesh>
          <mesh material={mats.black} position={[(PLATE_X + CHAIN_X) / 2, 0.045 + 0.002, 0.05]}>
            <boxGeometry args={[Math.abs(CHAIN_X - PLATE_X) + 0.01, 0.004, 0.02]} />
          </mesh>
          <mesh material={mats.black} position={[CHAIN_X, (0.049 + CHAIN_Y0 + 2 * CHAIN_R) / 2, 0.05]}>
            <boxGeometry args={[0.02, CHAIN_Y0 + 2 * CHAIN_R - 0.049 + 0.004, 0.004]} />
          </mesh>
          {/* mast bracket, mast and camera housing hang under the plate */}
          <mesh material={mats.black} position={[MAST_X - 0.01, 0.03, 0]} ref={addLayer1}>
            <boxGeometry args={[0.03, 0.03, 0.04]} />
          </mesh>
          <mesh material={mats.alu} position={[MAST_X, MAST_TOP - MAST_LEN / 2 - BEAM_Y, 0]} ref={addLayer1} castShadow>
            <boxGeometry args={[0.02, MAST_LEN, 0.02]} />
          </mesh>
          <group position={[MAST_X, -BEAM_Y, 0]}>
            <mesh material={camMats.cap} position={[0, HOUSING_TOP + 0.01, 0]} ref={addLayer1}>
              <boxGeometry args={[0.03, 0.02, 0.034]} />
            </mesh>
            <mesh material={camMats.acrylic} position={[0, CAMERA.lensHeight + HOUSING_H / 2, 0]} ref={addLayer1} renderOrder={4}>
              <cylinderGeometry args={[HOUSING_R, HOUSING_R, HOUSING_H, 24, 1, true]} />
            </mesh>
            <mesh material={camMats.cap} position={[0, CAMERA.lensHeight + 0.003, 0]} ref={addLayer1} castShadow>
              <cylinderGeometry args={[HOUSING_R + 0.001, HOUSING_R + 0.001, 0.006, 24]} />
            </mesh>
            <mesh material={camMats.cap} position={[0, HOUSING_TOP - 0.003, 0]} ref={addLayer1}>
              <cylinderGeometry args={[HOUSING_R + 0.001, HOUSING_R + 0.001, 0.006, 24]} />
            </mesh>
            {/* camera board and lens, facing down */}
            <mesh material={camMats.pcb} position={[0, CAMERA.lensHeight + 0.014, 0]} ref={addLayer1}>
              <boxGeometry args={[0.025, 0.0015, 0.024]} />
            </mesh>
            <mesh material={camMats.cap} position={[0, CAMERA.lensHeight + 0.009, 0]} ref={addLayer1}>
              <cylinderGeometry args={[0.005, 0.005, 0.008, 12]} />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  );
}
