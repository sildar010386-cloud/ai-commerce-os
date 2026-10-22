// 3D first frame for REEL-46 (2026-10-16): one pass of the steamer over creased white cotton leaves a smooth track.
// Owner idea 2026-10-15: "проводим один раз по мятой ткани — остаётся разглаженная дорожка"; realistic, not exaggerated.
// Texture = photo of our real white shirt (raw-05 clip 5, smooth half), so 3D matches the live shots that follow.
import React, {useMemo} from "react";
import {AbsoluteFill, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing} from "remotion";
import {ThreeCanvas} from "@remotion/three";
import * as THREE from "three";
import {useThree} from "@react-three/fiber";

const clamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const smooth = (a: number, b: number, x: number) => {const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t);};

const TEX = (() => {
  const t = new THREE.TextureLoader().load(staticFile("cotton_tex.jpg"));
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping; t.repeat.set(4, 3);
  return t;
})();
const PUFF = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d")!; const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,.9)"); r.addColorStop(0.35, "rgba(255,255,255,.45)"); r.addColorStop(0.7, "rgba(255,255,255,.12)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
})();

// crisp cotton creases (narrower and sharper than the knit)
const FOLDS = [
  {a: 0.2, ang: 1.25, c: -3.0, w: 0.09, bend: 0.9}, {a: 0.16, ang: 1.45, c: -1.4, w: 0.07, bend: -0.8}, {a: 0.24, ang: 1.6, c: 0.6, w: 0.12, bend: 0.7},
  {a: 0.14, ang: 1.15, c: 2.2, w: 0.06, bend: 1.0}, {a: 0.18, ang: 1.8, c: 3.6, w: 0.1, bend: -0.7}, {a: 0.12, ang: 0.3, c: -1.2, w: 0.05, bend: 0.6},
  {a: 0.1, ang: 0.55, c: 2.4, w: 0.06, bend: -0.5}, {a: 0.09, ang: 2.2, c: 0.2, w: 0.05, bend: 0.4}, {a: 0.13, ang: 1.0, c: -5.0, w: 0.08, bend: 0.8},
  {a: 0.11, ang: 1.9, c: 5.2, w: 0.07, bend: -0.6},
];
const height = (X: number, Y: number) => {
  const x = X * 2.4, y = Y * 2.4;
  let z = 0.06 * Math.sin(x * 0.35 + 0.6) * Math.cos(y * 0.28);
  for (const f of FOLDS) {
    const along = -x * Math.sin(f.ang) + y * Math.cos(f.ang);
    const d = x * Math.cos(f.ang) + y * Math.sin(f.ang) - f.c - f.bend * Math.sin(along * 0.6 + f.c);
    z += f.a * Math.exp(-(d * d) / f.w) * Math.max(0, 0.3 + 0.7 * Math.cos(along * 0.5 + f.c * 2));
  }
  z += 0.012 * Math.sin(x * 1.9 + y * 1.3 + Math.sin(y * 0.7) * 2) + 0.006 * Math.sin(x * 3.7 - y * 2.9 + Math.sin(x * 1.1) * 3);
  return z * 0.9;
};

const P0 = [-0.7, -1.3], P1 = [0.55, 2.5];
const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
const DIR = [(P1[0] - P0[0]) / L, (P1[1] - P0[1]) / L];
const headXY = (h: number) => [P0[0] + DIR[0] * h, P0[1] + DIR[1] * h];

const Cloth: React.FC<{head: number}> = ({head}) => {
  const geo = useMemo(() => new THREE.PlaneGeometry(6, 9, 270, 400), []);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = useMemo(() => new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3), [pos.count]);
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), y = pos.getY(k);
    const ax = x - P0[0], ay = y - P0[1];
    const along = ax * DIR[0] + ay * DIR[1];
    const perp = Math.abs(ax * DIR[1] - ay * DIR[0]);
    const inBand = 1 - smooth(0.34, 0.5, perp);
    const passed = 1 - smooth(head - 0.25, head + 0.08, along);
    const relax = 1 - 0.96 * inBand * passed * (along > -0.2 ? 1 : 0);
    pos.setZ(k, height(x, y) * relax);
    const b = 0.93 + 0.08 * inBand * passed * (along > -0.2 ? 1 : 0);
    col.setXYZ(k, b, b, b * 0.995);
  }
  pos.needsUpdate = true;
  geo.setAttribute("color", col); col.needsUpdate = true;
  geo.computeVertexNormals();
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]}>
      <meshStandardMaterial map={TEX} color={"#fbf8f3"} roughness={0.85} vertexColors />
    </mesh>
  );
};

// steam plume at the moving head: soft haze rising and drifting back along the track
const Plume: React.FC<{t: number; head: number; on: number}> = ({t, head, on}) => {
  const n = 1400;
  const geo = useMemo(() => new THREE.BufferGeometry(), []);
  const arr = new Float32Array(n * 3);
  const [hx, hy] = headXY(head);
  for (let i = 0; i < n; i++) {
    const r1 = ((i * 9301 + 49297) % 233280) / 233280, r2 = ((i * 4271 + 1231) % 9973) / 9973, r3 = ((i * 7919 + 17) % 6007) / 6007;
    const life = (r1 * 1.2 + t * 1.1) % 1.2;
    const back = life * 0.5;
    // round, centre-weighted cloud (a uniform square spread rendered as a visible square patch)
    const rad = 0.32 * Math.sqrt(r2) * (0.6 + 0.4 * life), ang = r3 * 6.2832;
    arr[i * 3] = hx - DIR[0] * back + rad * Math.cos(ang) + 0.05 * Math.sin(t * 2 + i);
    arr[i * 3 + 1] = 0.03 + life * 0.7;
    arr[i * 3 + 2] = -(hy - DIR[1] * back + rad * Math.sin(ang));
  }
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return (
    <points geometry={geo} renderOrder={2}>
      <pointsMaterial map={PUFF} color={"#ffffff"} size={0.32} sizeAttenuation transparent opacity={0.07 * on} depthWrite={false} />
    </points>
  );
};

const Haze: React.FC<{t: number; head: number}> = ({t, head}) => {
  const n = 700;
  const geo = useMemo(() => new THREE.BufferGeometry(), []);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r1 = ((i * 7331 + 11) % 10007) / 10007, r2 = ((i * 3571 + 7) % 8191) / 8191;
    const along = Math.min(head, L) * r1;
    const [x, y] = headXY(along);
    const age = Math.max(0, head - along);
    arr[i * 3] = x + (r2 - 0.5) * 0.5 + 0.04 * Math.sin(t * 1.3 + i);
    arr[i * 3 + 1] = 0.05 + Math.min(0.5, age * 0.25);
    arr[i * 3 + 2] = -y;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return (
    <points geometry={geo} renderOrder={3}>
      <pointsMaterial map={PUFF} color={"#ffffff"} size={0.2} sizeAttenuation transparent opacity={0.06} depthWrite={false} />
    </points>
  );
};

const Rig: React.FC<{t: number}> = ({t}) => {
  const {camera} = useThree();
  const p = Math.min(1, t / 2.6), e = p * p * (3 - 2 * p);
  camera.position.set(0.25 - 0.1 * e, 2.7 - 0.3 * e, 0.35 - 0.1 * e);
  camera.lookAt(0.05, 0, -0.45);
  camera.updateProjectionMatrix();
  return null;
};

export const Trail3D: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height: h} = useVideoConfig();
  const t = frame / fps;
  const head = interpolate(t, [0.15, 1.9], [-0.3, L + 0.4], {...clamp, easing: Easing.inOut(Easing.quad)});
  const on = interpolate(t, [0, 0.15, 1.9, 2.3], [0.6, 1, 1, 0.2], clamp);
  return (
    <AbsoluteFill style={{background: "#d9d2c8"}}>
      <ThreeCanvas width={width} height={h}>
        <Rig t={t} />
        <ambientLight intensity={0.6} color={"#ffffff"} />
        <directionalLight position={[-6, 1.5, -2.0]} intensity={2.8} color={"#fff3e6"} />
        <directionalLight position={[5, 5, 3]} intensity={0.7} color={"#eef3ff"} />
        <hemisphereLight args={["#fff8f0", "#8a7560", 0.45]} />
        <Cloth head={head} />
        <Plume t={t} head={head} on={on} />
        <Haze t={t} head={head} />
      </ThreeCanvas>
      <AbsoluteFill style={{background: "radial-gradient(ellipse at 50% 45%, transparent 60%, rgba(40,30,20,.35) 100%)"}} />
    </AbsoluteFill>
  );
};
