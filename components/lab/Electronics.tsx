"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { GANTRY } from "@/lib/sim/constants";
import { mergeBoxes, std, useHighlight } from "./util";

/** Electronics shelf cantilevered off the +X end of the frame. */
export const SHELF = { x0: 0.66, x1: 0.96, y: GANTRY.railHeight + 0.022, halfZ: 0.2 } as const;
export const ARDUINO_POS: [number, number, number] = [0.74, SHELF.y + 0.002, 0.09];
export const PI_POS: [number, number, number] = [0.86, SHELF.y + 0.002, 0.06];
export const PSU_POS: [number, number, number] = [0.8, SHELF.y + 0.002, -0.12];
/** Ground-truth camera: centred over the tank on an arm from a mast at the -X end, pointing straight down. */
export const OVERHEAD_CAM_POS: [number, number, number] = [0, 1.29, 0];
const OVERHEAD_MAST_X = -0.63;
const OVERHEAD_ARM_Y = 1.31;

function tube(points: THREE.Vector3[], r: number) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, r, 6, false);
}

export function Electronics() {
  const mats = useMemo(
    () => ({
      alu: std({ color: "#767b82", metalness: 0.6, roughness: 0.5, fog: false }),
      plate: std({ color: "#2a2d31", roughness: 0.7, metalness: 0.4, fog: false }),
      black: std({ color: "#141516", roughness: 0.85, fog: false }),
      silver: std({ color: "#a4a8ad", metalness: 0.85, roughness: 0.45, fog: false }),
      cable: std({ color: "#1a1a1c", roughness: 0.9, fog: false }),
      ribbon: std({ color: "#3a3f45", roughness: 0.9, fog: false }),
      psu: std({ color: "#1e1f22", roughness: 0.6, fog: false }),
      label: std({ color: "#d6d9dc", roughness: 0.5, fog: false }),
    }),
    [],
  );
  const ardMats = useMemo(
    () => ({
      pcb: std({ color: "#1f5f9a", roughness: 0.6, fog: false }),
      shield: std({ color: "#101214", roughness: 0.7, fog: false }),
      driver: std({ color: "#8a1f24", roughness: 0.6, fog: false }),
    }),
    [],
  );
  const piMats = useMemo(
    () => ({
      case: std({ color: "#111214", roughness: 0.75, fog: false }),
      pcb: std({ color: "#2b7a3f", roughness: 0.55, fog: false }),
    }),
    [],
  );
  useHighlight("arduino", [ardMats.pcb, ardMats.shield, ardMats.driver]);
  useHighlight("raspberry-pi", [piMats.case, piMats.pcb]);

  const shelfGeo = useMemo(() => {
    const len = SHELF.x1 - SHELF.x0 + 0.02;
    const cx = (SHELF.x1 + SHELF.x0) / 2 - 0.01;
    return mergeBoxes([
      { size: [len, 0.02, 0.02], at: [cx, GANTRY.railHeight + 0.01, SHELF.halfZ] },
      { size: [len, 0.02, 0.02], at: [cx, GANTRY.railHeight + 0.01, -SHELF.halfZ] },
      { size: [0.02, 0.02, SHELF.halfZ * 2], at: [SHELF.x1 - 0.01, GANTRY.railHeight + 0.01, 0] },
      // overhead camera: 2020 mast on the -X short member, arm to the tank centre, diagonal brace
      { size: [0.02, OVERHEAD_ARM_Y + 0.01 - (GANTRY.railHeight + 0.02), 0.02], at: [OVERHEAD_MAST_X, (OVERHEAD_ARM_Y + 0.01 + GANTRY.railHeight + 0.02) / 2, 0] },
      { size: [-OVERHEAD_MAST_X + 0.03, 0.02, 0.02], at: [(OVERHEAD_MAST_X + 0.03) / 2, OVERHEAD_ARM_Y, 0] },
      { size: [0.44, 0.015, 0.015], at: [OVERHEAD_MAST_X + 0.155, OVERHEAD_ARM_Y - 0.155, 0], rot: [0, 0, Math.PI / 4] },
    ]);
  }, []);

  const cables = useMemo(() => {
    const usb = tube(
      [
        new THREE.Vector3(ARDUINO_POS[0] - 0.034, ARDUINO_POS[1] + 0.012, ARDUINO_POS[2] + 0.02),
        new THREE.Vector3(ARDUINO_POS[0] - 0.05, ARDUINO_POS[1] + 0.01, ARDUINO_POS[2] + 0.06),
        new THREE.Vector3(PI_POS[0] - 0.02, PI_POS[1] + 0.01, PI_POS[2] + 0.09),
        new THREE.Vector3(PI_POS[0] + 0.02, PI_POS[1] + 0.012, PI_POS[2] + 0.06),
        new THREE.Vector3(PI_POS[0] + 0.048, PI_POS[1] + 0.012, PI_POS[2] + 0.015),
      ],
      0.002,
    );
    const power = tube(
      [
        new THREE.Vector3(PSU_POS[0] + 0.055, PSU_POS[1] + 0.012, PSU_POS[2]),
        new THREE.Vector3(PSU_POS[0] + 0.06, PSU_POS[1] + 0.01, PSU_POS[2] + 0.06),
        new THREE.Vector3(ARDUINO_POS[0] + 0.03, ARDUINO_POS[1] + 0.006, ARDUINO_POS[2] - 0.04),
        new THREE.Vector3(ARDUINO_POS[0] + 0.035, ARDUINO_POS[1] + 0.008, ARDUINO_POS[2] - 0.02),
      ],
      0.0018,
    );
    // camera ribbon: Pi -> over the shelf -> into the fixed end of the X cable chain
    const ribbon = tube(
      [
        new THREE.Vector3(PI_POS[0] - 0.047, PI_POS[1] + 0.012, PI_POS[2] - 0.02),
        new THREE.Vector3(0.72, GANTRY.railHeight + 0.03, 0.2),
        new THREE.Vector3(0.66, GANTRY.railHeight + 0.02, 0.29),
        new THREE.Vector3(0.615, GANTRY.railHeight + 0.011, 0.318),
      ],
      0.0025,
    );
    // stepper wires: Arduino -> X motor (outboard) and on into the X chain for the Y motor
    const stepper = tube(
      [
        new THREE.Vector3(ARDUINO_POS[0] + 0.02, ARDUINO_POS[1] + 0.03, ARDUINO_POS[2] + 0.02),
        new THREE.Vector3(0.7, GANTRY.railHeight + 0.05, 0.25),
        new THREE.Vector3(0.65, GANTRY.railHeight + 0.05, 0.34),
        new THREE.Vector3(0.62, GANTRY.railHeight + 0.03, 0.335),
        new THREE.Vector3(0.61, GANTRY.railHeight + 0.012, 0.318),
      ],
      0.002,
    );
    // overhead camera USB: along the arm, down the mast, along the -Z member to the Pi
    const overheadUsb = tube(
      [
        new THREE.Vector3(OVERHEAD_CAM_POS[0] + 0.01, OVERHEAD_CAM_POS[1] + 0.02, 0.012),
        new THREE.Vector3(-0.3, OVERHEAD_ARM_Y + 0.012, 0.012),
        new THREE.Vector3(OVERHEAD_MAST_X + 0.012, OVERHEAD_ARM_Y - 0.02, 0.012),
        new THREE.Vector3(OVERHEAD_MAST_X + 0.012, GANTRY.railHeight + 0.03, 0.0),
        new THREE.Vector3(OVERHEAD_MAST_X - 0.005, GANTRY.railHeight - 0.005, -0.2),
        new THREE.Vector3(-0.3, GANTRY.railHeight - 0.006, -0.315),
        new THREE.Vector3(0.4, GANTRY.railHeight - 0.006, -0.315),
        new THREE.Vector3(0.66, GANTRY.railHeight + 0.01, -0.15),
        new THREE.Vector3(PI_POS[0] + 0.052, PI_POS[1] + 0.012, PI_POS[2] - 0.013),
      ],
      0.002,
    );
    return { usb, power, ribbon, stepper, overheadUsb };
  }, []);

  return (
    <group>
      <mesh geometry={shelfGeo} material={mats.alu} castShadow />
      <mesh material={mats.plate} position={[(SHELF.x0 + SHELF.x1) / 2, SHELF.y, 0]}>
        <boxGeometry args={[SHELF.x1 - SHELF.x0, 0.004, SHELF.halfZ * 2 + 0.02]} />
      </mesh>

      {/* Arduino Uno with CNC shield */}
      <group position={ARDUINO_POS}>
        <mesh material={ardMats.pcb} position={[0, 0.006, 0]}>
          <boxGeometry args={[0.0686, 0.0016, 0.0534]} />
        </mesh>
        <mesh material={mats.silver} position={[-0.03, 0.011, 0.016]}>
          <boxGeometry args={[0.016, 0.011, 0.012]} />
        </mesh>
        <mesh material={mats.black} position={[-0.03, 0.011, -0.018]}>
          <boxGeometry args={[0.014, 0.011, 0.009]} />
        </mesh>
        <mesh material={ardMats.shield} position={[0.004, 0.019, 0]}>
          <boxGeometry args={[0.061, 0.0016, 0.0534]} />
        </mesh>
        {[-0.012, 0.01].map((z) => (
          <group key={z} position={[0.008, 0.022, z]}>
            <mesh material={ardMats.driver} position={[0, 0.004, 0]}>
              <boxGeometry args={[0.02, 0.0016, 0.015]} />
            </mesh>
            <mesh material={mats.silver} position={[0, 0.01, 0]}>
              <boxGeometry args={[0.009, 0.009, 0.009]} />
            </mesh>
          </group>
        ))}
        {/* screw terminals */}
        <mesh material={mats.label} position={[0.026, 0.025, -0.02]}>
          <boxGeometry args={[0.006, 0.008, 0.012]} />
        </mesh>
        <mesh material={mats.label} position={[0.026, 0.025, 0.02]}>
          <boxGeometry args={[0.006, 0.008, 0.012]} />
        </mesh>
      </group>

      {/* Raspberry Pi 4 in a black case, PCB edge and ports showing */}
      <group position={PI_POS}>
        {/* two-part case with a slot at PCB height so the board edge shows */}
        <mesh material={piMats.case} position={[0, 0.003, 0]}>
          <boxGeometry args={[0.093, 0.006, 0.062]} />
        </mesh>
        <mesh material={piMats.case} position={[0, 0.02, 0]} castShadow>
          <boxGeometry args={[0.093, 0.02, 0.062]} />
        </mesh>
        <mesh material={piMats.pcb} position={[0, 0.0078, 0]}>
          <boxGeometry args={[0.085, 0.0016, 0.056]} />
        </mesh>
        <mesh material={mats.silver} position={[0.049, 0.02, -0.013]}>
          <boxGeometry args={[0.008, 0.015, 0.013]} />
        </mesh>
        <mesh material={mats.silver} position={[0.049, 0.02, 0.005]}>
          <boxGeometry args={[0.008, 0.015, 0.013]} />
        </mesh>
        <mesh material={mats.silver} position={[0.049, 0.018, 0.022]}>
          <boxGeometry args={[0.008, 0.012, 0.015]} />
        </mesh>
        <mesh material={mats.black} position={[-0.02, 0.017, 0.032]}>
          <boxGeometry args={[0.02, 0.008, 0.004]} />
        </mesh>
      </group>

      {/* 12 V PSU brick */}
      <group position={PSU_POS}>
        <mesh material={mats.psu} position={[0, 0.016, 0]} castShadow>
          <boxGeometry args={[0.11, 0.032, 0.05]} />
        </mesh>
        <mesh material={mats.label} position={[0, 0.0325, 0]}>
          <boxGeometry args={[0.07, 0.0004, 0.03]} />
        </mesh>
        <mesh material={mats.black} position={[-0.056, 0.014, 0]}>
          <boxGeometry args={[0.004, 0.01, 0.02]} />
        </mesh>
      </group>

      <mesh geometry={cables.usb} material={mats.cable} />
      <mesh geometry={cables.power} material={mats.cable} />
      <mesh geometry={cables.stepper} material={mats.cable} />
      <mesh geometry={cables.ribbon} material={mats.ribbon} />
      <mesh geometry={cables.overheadUsb} material={mats.cable} />

      {/* overhead ground-truth camera under the arm, pointing straight down at the tank centre */}
      <group position={OVERHEAD_CAM_POS} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh material={mats.black} castShadow>
          <boxGeometry args={[0.03, 0.03, 0.04]} />
        </mesh>
        <mesh material={mats.silver} position={[0, 0, -0.024]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.008, 0.01, 0.01, 16]} />
        </mesh>
      </group>
    </group>
  );
}
