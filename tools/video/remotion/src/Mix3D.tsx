// 3D inserts mixed with live footage — demo v2 for the owner (2026-10-15).
// 3D shows what the camera cannot: the knit up close, steam flowing through it, creases relaxing behind the steam.
import React, {useMemo} from "react";
import {AbsoluteFill, Img, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing} from "remotion";
import {ThreeCanvas} from "@remotion/three";
import * as THREE from "three";
import {useThree} from "@react-three/fiber";

const FONT = '"Liberation Sans","DejaVu Sans",sans-serif';
const clamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const smooth = (a: number, b: number, x: number) => {const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t);};

// Procedural knit (stockinette V-stitches): colour map + bump map
// texture = photo of our real pink sweater (smooth area), so the 3D cloth is the same knit as in the live shots
const KNIT = (() => {
  const t = new THREE.TextureLoader().load(staticFile("knit_photo.jpg"));
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return {map: t, bump: t};
})();

// soft puff for steam
const PUFF = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d")!; const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,.9)"); r.addColorStop(0.35, "rgba(255,255,255,.45)"); r.addColorStop(0.7, "rgba(255,255,255,.12)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
})();

const FOLDS = [
  {a: 0.24, ang: 0.25, c: -3.4, w: 0.06, bend: 1.0}, {a: 0.18, ang: 0.05, c: -1.6, w: 0.04, bend: -0.9}, {a: 0.3, ang: -0.18, c: 0.9, w: 0.08, bend: 0.8},
  {a: 0.16, ang: 0.4, c: 2.6, w: 0.04, bend: 1.1}, {a: 0.2, ang: -0.35, c: 4.0, w: 0.05, bend: -0.8}, {a: 0.12, ang: 1.35, c: -1.8, w: 0.03, bend: 0.7},
  {a: 0.1, ang: 1.1, c: 3.1, w: 0.03, bend: -0.6},
];
const height = (X: number, Y: number) => {
  const x = X * 2.2, y = Y * 2.2;
  let z = 0.08 * Math.sin(x * 0.35 + 0.6) * Math.cos(y * 0.28);
  for (const f of FOLDS) {
    const along = -x * Math.sin(f.ang) + y * Math.cos(f.ang);
    const d = x * Math.cos(f.ang) + y * Math.sin(f.ang) - f.c - f.bend * Math.sin(along * 0.6 + f.c);
    z += f.a * Math.exp(-(d * d) / f.w) * Math.max(0, 0.35 + 0.65 * Math.cos(along * 0.55 + f.c * 2));
  }
  z += 0.025 * Math.sin(x * 2.3 + y * 1.7) + 0.015 * Math.sin(x * 5.1 - y * 3.3);
  return z * 0.45;
};

// front: x position of the steam wave; behind it (x < front) creases relax
const Fabric: React.FC<{front: number}> = ({front}) => {
  const geo = useMemo(() => new THREE.PlaneGeometry(4, 6, 200, 300), []);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), y = pos.getY(k);
    const relax = 1 - 0.95 * smooth(front + 0.35, front - 0.6, x);
    pos.setZ(k, height(x, y) * relax + 0.015 * Math.sin(x * 0.8) * Math.cos(y * 0.6));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]}>
      <meshStandardMaterial map={KNIT.map} bumpMap={KNIT.bump} bumpScale={0.8} color={"#ffffff"} roughness={0.95} />
    </mesh>
  );
};

const SteamWave: React.FC<{t: number; front: number}> = ({t, front}) => {
  const n = 700;
  const geo = useMemo(() => new THREE.BufferGeometry(), []);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r1 = ((i * 9301 + 49297) % 233280) / 233280, r2 = ((i * 4271 + 1231) % 9973) / 9973, r3 = ((i * 7919 + 17) % 6007) / 6007;
    const life = (r1 * 2.4 + t * 0.8) % 2.4;
    arr[i * 3] = front - 0.2 + (r2 - 0.5) * 1.3 - life * 0.35 + 0.1 * Math.sin(t * 1.7 + i);
    arr[i * 3 + 1] = 0.05 + life * 0.35 + 0.04 * Math.sin(t * 2.1 + i * 0.7);
    arr[i * 3 + 2] = -3.0 + r3 * 6;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return (
    <points geometry={geo} renderOrder={2}>
      <pointsMaterial map={PUFF} color={"#ffffff"} size={0.9} sizeAttenuation transparent opacity={0.2} depthWrite={false} />
    </points>
  );
};

const Studio: React.FC = () => (
  <>
    <ambientLight intensity={0.55} color={"#ffffff"} />
    <directionalLight position={[-6, 2.0, 0.8]} intensity={3.0} color={"#fff1e0"} />
    <directionalLight position={[6, 6, -4]} intensity={0.9} color={"#ffc9e6"} />
    <hemisphereLight args={["#fff4f6", "#3a2030", 0.4]} />
    <fog attach="fog" args={["#2a1424", 14, 30]} />
  </>
);

const Plate: React.FC<{text: string; bg?: string; color?: string}> = ({text, bg = "#FFD60A", color = "#111"}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame, fps, config: {damping: 11}});
  return (
    <div style={{position: "absolute", left: 60, right: 60, top: 110, textAlign: "center", fontFamily: FONT, fontWeight: 900, fontSize: 58,
      background: bg, color, borderRadius: 22, padding: "16px 20px", transform: `scale(${0.6 + 0.4 * s})`, opacity: s, boxShadow: "0 8px 24px rgba(0,0,0,.3)"}}>{text}</div>
  );
};

const Vignette = () => <AbsoluteFill style={{background: "radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(20,8,16,.55) 100%)"}} />;

// 0–3 s: macro of the knit with creases, slow dolly
const SceneKnit: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height: h} = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{background: "#2a1424"}}>
      <ThreeCanvas width={width} height={h}>
        <Cam t={t} from={[0.2, 3.3, 1.0]} to={[-0.1, 2.8, 0.8]} dur={3} look={[0, 0, -0.2]} />
        <Studio />
        <Fabric front={-20} />
      </ThreeCanvas>
      <Vignette />
      <Plate text="Как пар разглаживает ткань? 👀" />
    </AbsoluteFill>
  );
};

// camera helper (deterministic per frame)
const Cam: React.FC<{t: number; from: number[]; to: number[]; dur: number; look: number[]}> = ({t, from, to, dur, look}) => {
  const p = Math.min(1, t / dur), e = p * p * (3 - 2 * p);
  return <PerspectiveRig position={from.map((v, i) => v + (to[i] - v) * e) as [number, number, number]} look={look as [number, number, number]} />;
};
const PerspectiveRig: React.FC<{position: [number, number, number]; look: [number, number, number]}> = ({position, look}) => {
  const {camera} = useThree();
  camera.position.set(...position);
  camera.lookAt(...look);
  camera.updateProjectionMatrix();
  return null;
};

// 3–5 s: real steam burst from our steamer
const SceneRealSteam: React.FC = () => (
  <AbsoluteFill>
    <OffthreadVideo src={staticFile("clean43.mp4")} trimBefore={Math.round(8.25 * 30)} muted style={{width: "100%", height: "100%", objectFit: "cover"}} />
    <Plate text="Ведём паром по свитеру 💨" bg="#ffffff" />
  </AbsoluteFill>
);

// 5–8.5 s: steam wave crosses the knit; creases relax behind it
const SceneWave: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height: h} = useVideoConfig();
  const t = frame / fps;
  const front = interpolate(t, [0.2, 3.2], [-2.2, 2.2], {...clamp, easing: Easing.inOut(Easing.quad)});
  return (
    <AbsoluteFill style={{background: "#2a1424"}}>
      <ThreeCanvas width={width} height={h}>
        <Cam t={t} from={[-0.15, 3.1, 0.95]} to={[0.15, 2.95, 0.9]} dur={3.5} look={[0, 0, -0.2]} />
        <Studio />
        <Fabric front={front} />
        <SteamWave t={t} front={front} />
      </ThreeCanvas>
      <Vignette />
      <Plate text={front < 0.6 ? "Пар проходит через волокна…" : "Складки уходят ✨"} bg={front < 0.6 ? "#ffffff" : "#3DDC84"} color={front < 0.6 ? "#111" : "#fff"} />
    </AbsoluteFill>
  );
};

// 8.5–11 s: real before/after + ПАР
const SceneBeforeAfter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const p = interpolate(t, [0.35, 1.05], [0, 1], {...clamp, easing: Easing.inOut(Easing.quad)});
  const s = spring({frame: frame - Math.round(1.25 * fps), fps, config: {damping: 9}});
  const pulse = t > 1.8 ? 1 + 0.05 * Math.sin((t - 1.8) * 9) : 1;
  return (
    <AbsoluteFill>
      <Img src={staticFile("before.jpg")} style={{position: "absolute", width: "100%", height: "100%", objectFit: "cover"}} />
      <Img src={staticFile("after.jpg")} style={{position: "absolute", width: "100%", height: "100%", objectFit: "cover", clipPath: `inset(0 0 0 ${100 - p * 100}%)`}} />
      {p > 0 && p < 1 && <div style={{position: "absolute", top: 0, bottom: 0, left: 1070 - p * 1070, width: 10, background: "#fff", boxShadow: "0 0 20px #fff"}} />}
      {p < 0.85 && <div style={{position: "absolute", left: 40, top: 360, fontFamily: FONT, fontWeight: 900, fontSize: 90, color: "#FF4D4D", textShadow: "0 5px 0 #000,3px 0 0 #000,-3px 0 0 #000"}}>ДО</div>}
      {p > 0.1 && <div style={{position: "absolute", right: 40, top: 360, fontFamily: FONT, fontWeight: 900, fontSize: 90, color: "#3DDC84", textShadow: "0 5px 0 #000,3px 0 0 #000,-3px 0 0 #000"}}>ПОСЛЕ ✨</div>}
      <div style={{position: "absolute", left: 140, right: 140, top: 1180, height: 170, borderRadius: 85, background: "#fff", display: "flex", alignItems: "center",
        justifyContent: "center", fontFamily: FONT, fontWeight: 900, fontSize: 100, color: "#FF7A1A", opacity: s, transform: `scale(${s * pulse})`, boxShadow: "0 14px 40px rgba(0,0,0,.4)"}}>💬 ПАР</div>
    </AbsoluteFill>
  );
};

const Flash: React.FC<{at: number}> = ({at}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const d = frame / fps - at;
  const o = d >= 0 && d < 0.22 ? interpolate(d, [0, 0.05, 0.22], [0, 0.6, 0]) : 0;
  return <AbsoluteFill style={{background: "#fff", opacity: o}} />;
};

export const Mix3D: React.FC = () => {
  const {fps} = useVideoConfig();
  const S = (a: number) => Math.round(a * fps);
  return (
    <AbsoluteFill style={{background: "#000"}}>
      <Sequence from={0} durationInFrames={S(3)}><SceneKnit /></Sequence>
      <Sequence from={S(3)} durationInFrames={S(2)}><SceneRealSteam /></Sequence>
      <Sequence from={S(5)} durationInFrames={S(3.5)}><SceneWave /></Sequence>
      <Sequence from={S(8.5)} durationInFrames={S(2.5)}><SceneBeforeAfter /></Sequence>
      <Flash at={3} /><Flash at={5} /><Flash at={8.5} />
    </AbsoluteFill>
  );
};

// 2.6 s insert without plates (the HyperFrames layer adds captions): steam wave relaxes the creases of our pink knit
export const Wave3D: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height: h} = useVideoConfig();
  const t = frame / fps;
  const front = interpolate(t, [0.1, 2.4], [-2.2, 2.2], {...clamp, easing: Easing.inOut(Easing.quad)});
  return (
    <AbsoluteFill style={{background: "#2a1424"}}>
      <ThreeCanvas width={width} height={h}>
        <Cam t={t} from={[-0.1, 2.35, 0.75]} to={[0.1, 2.2, 0.7]} dur={2.6} look={[0, 0, 0.2]} />
        <Studio />
        <Fabric front={front} />
        <SteamWave t={t} front={front} />
      </ThreeCanvas>
      <Vignette />
    </AbsoluteFill>
  );
};
