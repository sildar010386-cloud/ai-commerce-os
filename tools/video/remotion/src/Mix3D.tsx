// 3D inserts mixed with live footage — quick demo for the owner (2026-10-15).
import React, {useMemo} from "react";
import {AbsoluteFill, Img, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing} from "remotion";
import {ThreeCanvas} from "@remotion/three";
import * as THREE from "three";

const FONT = '"Liberation Sans","DejaVu Sans",sans-serif';
const clamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;

// deterministic folds
const FOLDS = Array.from({length: 7}, (_, i) => ({a: 0.25 + 0.12 * Math.sin(i * 3.1), ang: i * 0.9 + 0.3, c: -3 + i * 1.0, w: 0.08 + 0.05 * Math.cos(i)}));

const Fabric: React.FC<{amp: number; t: number; color: string}> = ({amp, t, color}) => {
  const geo = useMemo(() => new THREE.PlaneGeometry(7, 9, 140, 180), []);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), y = pos.getY(k);
    let z = 0;
    for (const f of FOLDS) {
      const d = x * Math.cos(f.ang) + y * Math.sin(f.ang) - f.c;
      z += f.a * Math.exp(-(d * d) / f.w);
    }
    z += 0.04 * Math.sin(x * 3 + t) * Math.cos(y * 2.5);
    pos.setZ(k, z * amp);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2.6, 0, 0.2]}>
      <meshPhysicalMaterial color={color} roughness={0.42} metalness={0.02} sheen={1} sheenRoughness={0.3} sheenColor={"#ffe3ef"} clearcoat={0.15} side={THREE.DoubleSide} />
    </mesh>
  );
};

// soft round sprite for steam puffs
const PUFF = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!; const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.4, "rgba(255,255,255,.55)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
})();

const Steam: React.FC<{t: number; n?: number; spread?: number; origin?: [number, number, number]; opacity?: number}> = ({t, n = 700, spread = 2.2, origin = [0, -1, 0], opacity = 0.9}) => {
  const geo = useMemo(() => new THREE.BufferGeometry(), []);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const seed = (i * 9301 + 49297) % 233280 / 233280;
    const s2 = (i * 4271 + 1231) % 9973 / 9973;
    const life = (seed * 3 + t * 0.9) % 3; // 0..3
    arr[i * 3] = origin[0] + (s2 - 0.5) * spread * (0.3 + life) + 0.3 * Math.sin(t * 2 + i);
    arr[i * 3 + 1] = origin[1] + life * 1.6;
    arr[i * 3 + 2] = origin[2] + (seed - 0.5) * spread * (0.3 + life * 0.6);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return (
    <points geometry={geo}>
      <pointsMaterial map={PUFF} color={"#ffffff"} size={0.55} sizeAttenuation transparent opacity={opacity * 0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

const Lights = () => (
  <>
    <ambientLight intensity={0.55} />
    <directionalLight position={[4, 6, 5]} intensity={2.2} color={"#fff4e6"} />
    <directionalLight position={[-5, 2, -3]} intensity={0.8} color={"#ff9ad5"} />
  </>
);

const Plate: React.FC<{text: string; bg?: string; color?: string}> = ({text, bg = "#FFD60A", color = "#111"}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame, fps, config: {damping: 10}});
  return (
    <div style={{position: "absolute", left: 60, right: 60, top: 110, textAlign: "center", fontFamily: FONT, fontWeight: 900, fontSize: 58,
      background: bg, color, borderRadius: 22, padding: "16px 20px", transform: `scale(${0.6 + 0.4 * s})`, opacity: s}}>{text}</div>
  );
};

// 0–2.5 s: 3D silk with folds, slow orbit
const SceneSilk: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{background: "radial-gradient(circle at 50% 40%, #3a1d4f 0%, #12071c 75%)"}}>
      <ThreeCanvas width={width} height={height} camera={{position: [Math.sin(t * 0.4) * 2.5, 9 - t * 0.5, 11], fov: 45}}>
        <Lights />
        <Fabric amp={1} t={t} color={"#e7a3b8"} />
      </ThreeCanvas>
      <Plate text="Как пар разглаживает ткань? 👀" />
    </AbsoluteFill>
  );
};

// 2.5–5 s: real footage + 3D steam particles over it
const SceneRealSteam: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill>
      <OffthreadVideo src={staticFile("clean41.mp4")} trimBefore={Math.round(10.8 * fps)} muted style={{width: "100%", height: "100%", objectFit: "cover"}} />
      <AbsoluteFill>
        <ThreeCanvas width={width} height={height} gl={{alpha: true}} camera={{position: [0, 0, 8], fov: 50}}>
          <Steam t={t + 1} n={260} spread={2.4} origin={[0.8, -3.0, 0]} />
        </ThreeCanvas>
      </AbsoluteFill>
      <Plate text="Пар 100° проникает в волокна 💨" bg="#ffffff" />
    </AbsoluteFill>
  );
};

// 5–7.5 s: 3D silk, steam passes, folds flatten
const SceneFlatten: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const t = frame / fps;
  const amp = interpolate(t, [0.3, 2.0], [1, 0.02], {...clamp, easing: Easing.inOut(Easing.cubic)});
  return (
    <AbsoluteFill style={{background: "radial-gradient(circle at 50% 40%, #3a1d4f 0%, #12071c 75%)"}}>
      <ThreeCanvas width={width} height={height} camera={{position: [-1.5 + t * 0.6, 8, 10.5], fov: 45}}>
        <Lights />
        <Fabric amp={amp} t={t} color={"#e7a3b8"} />
        <Steam t={t} n={240} spread={5} origin={[-2.5 + t * 2.4, -0.2, 0]} opacity={0.8} />
      </ThreeCanvas>
      <Plate text={amp > 0.3 ? "Складки…" : "Гладко ✨"} bg={amp > 0.3 ? "#FF4D4D" : "#3DDC84"} color="#fff" />
    </AbsoluteFill>
  );
};

// 7.5–10 s: real before/after (pink sweater) + ПАР
const SceneBeforeAfter: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const p = interpolate(t, [0.3, 1.0], [0, 1], {...clamp, easing: Easing.inOut(Easing.quad)});
  const s = spring({frame: frame - Math.round(1.2 * fps), fps, config: {damping: 9}});
  return (
    <AbsoluteFill>
      <Img src={staticFile("before.jpg")} style={{position: "absolute", width: "100%", height: "100%", objectFit: "cover"}} />
      <Img src={staticFile("after.jpg")} style={{position: "absolute", width: "100%", height: "100%", objectFit: "cover", clipPath: `inset(0 0 0 ${100 - p * 100}%)`}} />
      {p > 0 && p < 1 && <div style={{position: "absolute", top: 0, bottom: 0, left: 1070 - p * 1070, width: 10, background: "#fff", boxShadow: "0 0 20px #fff"}} />}
      {p < 0.85 && <div style={{position: "absolute", left: 40, top: 360, fontFamily: FONT, fontWeight: 900, fontSize: 90, color: "#FF4D4D", textShadow: "0 5px 0 #000,3px 0 0 #000,-3px 0 0 #000"}}>ДО</div>}
      {p > 0.1 && <div style={{position: "absolute", right: 40, top: 360, fontFamily: FONT, fontWeight: 900, fontSize: 90, color: "#3DDC84", textShadow: "0 5px 0 #000,3px 0 0 #000,-3px 0 0 #000"}}>ПОСЛЕ ✨</div>}
      <div style={{position: "absolute", left: 140, right: 140, top: 1180, height: 170, borderRadius: 85, background: "#fff", display: "flex", alignItems: "center",
        justifyContent: "center", fontFamily: FONT, fontWeight: 900, fontSize: 100, color: "#FF7A1A", opacity: s, transform: `scale(${s})`, boxShadow: "0 14px 40px rgba(0,0,0,.4)"}}>💬 ПАР</div>
    </AbsoluteFill>
  );
};

const Flash: React.FC<{at: number}> = ({at}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const d = frame / fps - at;
  const o = d >= 0 && d < 0.2 ? interpolate(d, [0, 0.04, 0.2], [0, 0.7, 0]) : 0;
  return <AbsoluteFill style={{background: "#fff", opacity: o}} />;
};

export const Mix3D: React.FC = () => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{background: "#000"}}>
      <Sequence from={0} durationInFrames={Math.round(2.5 * fps)}><SceneSilk /></Sequence>
      <Sequence from={Math.round(2.5 * fps)} durationInFrames={Math.round(2.5 * fps)}><SceneRealSteam /></Sequence>
      <Sequence from={Math.round(5 * fps)} durationInFrames={Math.round(2.5 * fps)}><SceneFlatten /></Sequence>
      <Sequence from={Math.round(7.5 * fps)} durationInFrames={Math.round(2.5 * fps)}><SceneBeforeAfter /></Sequence>
      <Flash at={2.5} /><Flash at={5} /><Flash at={7.5} />
    </AbsoluteFill>
  );
};
