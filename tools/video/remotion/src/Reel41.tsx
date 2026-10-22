// REEL-41 «Холодает» — Remotion version of the compact layout (owner 2026-10-15: animation small, semi-transparent,
// top band only; captions at the bottom; the middle stays free for the live footage).
import React from "react";
import {AbsoluteFill, OffthreadVideo, Easing, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import data from "../public/data41.json";

const FONT = '"Liberation Sans","DejaVu Sans",sans-serif';
const COLORS: Record<string, string> = {y: "#FFD60A", o: "#FF7A1A", g: "#3DDC84", r: "#FF4D4D"};
const KEYS = data.keywords as Record<string, string>;
const clamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const useT = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return {frame, fps, t: frame / fps};
};
const pop = (frame: number, fps: number, at: number, damping = 12) =>
  spring({frame: frame - Math.round(at * fps), fps, config: {damping, stiffness: 170, mass: 0.7}});

const Background: React.FC = () => {
  const {t} = useT();
  let since = t;
  for (const c of data.cuts) if (t >= c) since = t - c;
  const punch = interpolate(since, [0, 0.18, 0.5], [1.08, 1.03, 1.0], {...clamp, easing: Easing.out(Easing.cubic)});
  return (
    <AbsoluteFill style={{transform: `scale(${punch})`}}>
      <OffthreadVideo src={staticFile("clean41.mp4")} muted style={{width: "100%", height: "100%", objectFit: "cover"}} />
    </AbsoluteFill>
  );
};

const CutFlash: React.FC = () => {
  const {t} = useT();
  let o = 0;
  for (const c of data.cuts) {
    const d = t - c;
    if (d >= 0 && d < 0.18) o = Math.max(o, interpolate(d, [0, 0.04, 0.18], [0, 0.35, 0]));
  }
  return <AbsoluteFill style={{background: "radial-gradient(circle at 75% 20%, #fff6e0 0%, rgba(255,240,210,.5) 40%, transparent 70%)", opacity: o}} />;
};

const Captions: React.FC = () => {
  const {t, fps, frame} = useT();
  const off = data.offset;
  const chunks = data.chunks as [string, number, number][][];
  let idx = -1;
  for (let i = 0; i < chunks.length; i++) if (t >= off + chunks[i][0][1]) idx = i;
  if (idx < 0) return null;
  const c = chunks[idx];
  const end = idx + 1 < chunks.length ? off + chunks[idx + 1][0][1] : off + c[c.length - 1][2] + 0.5;
  if (t > end) return null;
  return (
    <div style={{position: "absolute", left: 50, right: 50, top: 1530, textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: 78,
      lineHeight: 1.12, color: "#fff", textShadow: "0 5px 0 #000,0 0 16px rgba(0,0,0,.85),3px 0 0 #000,-3px 0 0 #000"}}>
      {c.map(([w, ws], i) => {
        const s = pop(frame, fps, off + ws, 9);
        const key = KEYS[w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")];
        return <span key={i} style={{display: "inline-block", margin: "0 8px", opacity: s > 0.01 ? 1 : 0,
          transform: `translateY(${(1 - s) * 36}px) scale(${0.55 + 0.45 * s})`, color: key ? COLORS[key] : "#fff"}}>{w}</span>;
      })}
    </div>
  );
};

// Top plate (hook, then CTA)
const Plate: React.FC<{text: string; at: number; out: number; bg: string; color: string}> = ({text, at, out, bg, color}) => {
  const {t, fps, frame} = useT();
  if (t < at || t > out) return null;
  const s = pop(frame, fps, at, 10);
  const o = interpolate(t, [out - 0.2, out], [1, 0], clamp);
  return (
    <div style={{position: "absolute", left: 60, right: 60, top: 110, textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: 54,
      lineHeight: 1.15, background: bg, color, borderRadius: 22, padding: "16px 20px", opacity: Math.min(s, o), transform: `scale(${0.6 + 0.4 * s})`}}>{text}</div>
  );
};

// Glass band for widgets — the only animated area
const Band: React.FC<{at: number; out: number; children: React.ReactNode}> = ({at, out, children}) => {
  const {t, fps, frame} = useT();
  if (t < at || t > out) return null;
  const s = pop(frame, fps, at, 13);
  const o = interpolate(t, [out - 0.18, out], [1, 0], clamp);
  return (
    <div style={{position: "absolute", left: 60, right: 60, top: 315, height: 250, borderRadius: 34, background: "rgba(255,255,255,.62)",
      backdropFilter: "blur(8px)", boxShadow: "0 10px 30px rgba(0,0,0,.25)", fontFamily: FONT, color: "#151515", overflow: "hidden",
      opacity: Math.min(s, o), transform: `translateY(${(1 - s) * -30}px) scale(${0.92 + 0.08 * s})`}}>{children}</div>
  );
};
const T: React.FC<{style: React.CSSProperties; children: React.ReactNode}> = ({style, children}) =>
  <div style={{position: "absolute", fontWeight: 900, whiteSpace: "nowrap", ...style}}>{children}</div>;

const Cold: React.FC = () => {
  const {t} = useT();
  const v = Math.round(interpolate(t, [0.4, 2.0], [12, 3], {...clamp, easing: Easing.inOut(Easing.quad)}));
  const shiver = t > 2.0 ? Math.sin(t * 40) * interpolate(t, [2.0, 2.6], [5, 0], clamp) : 0;
  return (
    <Band at={0.1} out={4.8}>
      <T style={{left: 40, top: 40, fontSize: 150, transform: `rotate(${shiver}deg)`}}>🥶</T>
      <T style={{left: 230, top: 30, fontSize: 120, color: "#2F80ED"}}>+{v}°</T>
      <T style={{left: 232, top: 168, fontSize: 46}}>на улице холодает</T>
    </Band>
  );
};

const Hour: React.FC = () => {
  const {t, fps, frame} = useT();
  const w = interpolate(t, [5.1, 6.0], [0, 1], {...clamp, easing: Easing.out(Easing.cubic)});
  const m = pop(frame, fps, 6.0, 8);
  return (
    <Band at={4.9} out={7.4}>
      <T style={{left: 40, top: 30, fontSize: 54}}>Раньше: утюг и доска</T>
      <div style={{position: "absolute", left: 40, top: 120, height: 84, width: 660 * w, borderRadius: 42, background: "#FF4D4D"}} />
      <T style={{left: 60, top: 126, fontSize: 62, color: "#fff", opacity: w > 0.6 ? 1 : 0}}>час 😩</T>
      <T style={{right: 40, top: 100, fontSize: 100, transform: `scale(${m})`}}>❌</T>
    </Band>
  );
};

const Ring: React.FC = () => {
  const {t} = useT();
  const p = interpolate(t, [7.75, 8.9], [0, 1], {...clamp, easing: Easing.out(Easing.quad)});
  const C = 2 * Math.PI * 90;
  return (
    <Band at={7.5} out={9.9}>
      <svg width={240} height={240} style={{position: "absolute", left: 20, top: 5}}>
        <circle cx={120} cy={120} r={90} fill="none" stroke="rgba(0,0,0,.12)" strokeWidth={22} />
        <circle cx={120} cy={120} r={90} fill="none" stroke="#FF7A1A" strokeWidth={22} strokeLinecap="round" transform="rotate(-90 120 120)"
          strokeDasharray={C} strokeDashoffset={C * (1 - p)} />
      </svg>
      <T style={{left: 20, top: 62, width: 240, textAlign: "center", fontSize: 100, color: "#FF7A1A"}}>{Math.round(9 * p)}</T>
      <T style={{left: 290, top: 70, fontSize: 62, whiteSpace: "normal", width: 640, lineHeight: 1.15}}>секунд — и пар готов 💨</T>
    </Band>
  );
};

const Crease: React.FC = () => {
  const {t} = useT();
  const k = interpolate(t, [11.0, 13.0], [1, 0], {...clamp, easing: Easing.inOut(Easing.cubic)});
  const pts: string[] = [];
  for (let x = 0; x <= 840; x += 12) {
    const y = 85 + k * (38 * Math.sin(x / 23) + 22 * Math.sin(x / 9 + 1) + 12 * Math.sin(x / 4));
    pts.push(`${x + 60},${y.toFixed(1)}`);
  }
  const smooth = k < 0.5;
  return (
    <Band at={10.0} out={13.5}>
      <T style={{left: 40, top: 22, fontSize: 52, color: smooth ? "#1FAF5A" : "#FF4D4D"}}>{smooth ? "гладко ✨" : "заломы 😩"}</T>
      <svg width={960} height={170} style={{position: "absolute", left: 0, top: 80}}>
        <polyline points={pts.join(" ")} fill="none" stroke={smooth ? "#1FAF5A" : "#FF4D4D"} strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Band>
  );
};

const Compare: React.FC = () => {
  const {t} = useT();
  const rows: [string, number, string, string, string, number][] = [["Доска", 360, "60 мин", "#FF4D4D", "❌", 13.85], ["Пар", 70, "2 мин", "#1FAF5A", "✅", 14.35]];
  return (
    <Band at={13.6} out={15.8}>
      {rows.map(([l, w, txt, col, mark, at], j) => {
        const p = interpolate(t, [at, at + 0.5], [0, 1], {...clamp, easing: Easing.out(Easing.cubic)});
        return (
          <React.Fragment key={j}>
            <T style={{left: 40, top: 36 + j * 110, fontSize: 50}}>{l}</T>
            <div style={{position: "absolute", left: 330, top: 28 + j * 110, height: 76, width: w * p, borderRadius: 38, background: col}} />
            <T style={{left: 345 + w, top: 36 + j * 110, fontSize: 52, color: col, opacity: p > 0.7 ? 1 : 0}}>{txt} {mark}</T>
          </React.Fragment>
        );
      })}
    </Band>
  );
};

const Bubble: React.FC = () => {
  const {t} = useT();
  const pulse = t > 16.8 ? 1 + 0.06 * Math.sin((t - 16.8) * 9) : 1;
  return (
    <Band at={15.9} out={30}>
      <T style={{left: 0, right: 0, top: 20, textAlign: "center", fontSize: 120, color: "#FF7A1A", transform: `scale(${pulse})`}}>
        💬 {"ПАР".split("").map((l, i) => <span key={i} style={{opacity: t > 16.25 + i * 0.16 ? 1 : 0}}>{l}</span>)}
      </T>
      <T style={{left: 0, right: 0, top: 170, textAlign: "center", fontSize: 46, transform: `translateY(${Math.sin(t * 6) * 6}px)`}}>👇 напишите в комментариях</T>
    </Band>
  );
};

export const Reel41: React.FC = () => (
  <AbsoluteFill style={{background: "#000"}}>
    <Background />
    <CutFlash />
    <Plate text="Холодает — а вещи в заломах 🥶" at={0} out={4.8} bg="#FFD60A" color="#111" />
    <Plate text="Напишите «ПАР» в комментариях" at={9.9} out={30} bg="#FF7A1A" color="#fff" />
    <Cold />
    <Hour />
    <Ring />
    <Crease />
    <Compare />
    <Bubble />
    <Captions />
  </AbsoluteFill>
);
