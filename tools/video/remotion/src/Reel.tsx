// REEL-42 «Придумали, как гладить без доски» — Remotion motion-graphics test (owner request 2026-10-15).
// Live footage stays underneath (product in action is always real); Remotion adds the animated layer.
import React from "react";
import {AbsoluteFill, OffthreadVideo, Easing, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from "remotion";
import data from "../public/data.json";

const FONT = '"Liberation Sans","DejaVu Sans",sans-serif';
const COLORS: Record<string, string> = {y: "#FFD60A", o: "#FF7A1A", g: "#3DDC84", r: "#FF4D4D"};
const KEYS = data.keywords as Record<string, string>;
const clamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;

const useT = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return {frame, fps, t: frame / fps};
};

// spring that starts at second `at`
const pop = (frame: number, fps: number, at: number, damping = 11) =>
  spring({frame: frame - Math.round(at * fps), fps, config: {damping, stiffness: 170, mass: 0.7}});

const Window: React.FC<{from: number; to: number; children: React.ReactNode}> = ({from, to, children}) => {
  const {t} = useT();
  if (t < from || t > to) return null;
  return <>{children}</>;
};

// Background: live footage + punch-in on every cut + slow drift
const Background: React.FC = () => {
  const {t} = useT();
  let since = t;
  for (const c of data.cuts) if (t >= c) since = t - c;
  const punch = interpolate(since, [0, 0.18, 0.5], [1.12, 1.04, 1.0], {...clamp, easing: Easing.out(Easing.cubic)});
  const drift = 1 + 0.03 * Math.sin(t * 0.8);
  return (
    <AbsoluteFill style={{transform: `scale(${punch * drift})`}}>
      <OffthreadVideo src={staticFile("clean.mp4")} muted style={{width: "100%", height: "100%", objectFit: "cover"}} />
    </AbsoluteFill>
  );
};

// White flash on cuts (light leak style)
const CutFlash: React.FC = () => {
  const {t} = useT();
  let o = 0;
  for (const c of data.cuts) {
    const d = t - c;
    if (d >= 0 && d < 0.2) o = Math.max(o, interpolate(d, [0, 0.04, 0.2], [0, 0.55, 0]));
  }
  return <AbsoluteFill style={{background: "radial-gradient(circle at 70% 30%, #fff8e6 0%, rgba(255,240,210,.6) 45%, transparent 75%)", opacity: o}} />;
};

// Word-by-word captions, keywords coloured and punched
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
    <div style={{position: "absolute", left: 50, right: 50, top: 1240, textAlign: "center", fontFamily: FONT, fontWeight: 800,
      fontSize: 88, lineHeight: 1.12, color: "#fff", textShadow: "0 5px 0 #000,0 0 16px rgba(0,0,0,.85),3px 0 0 #000,-3px 0 0 #000"}}>
      {c.map(([w, ws], i) => {
        const s = pop(frame, fps, off + ws, 9);
        const key = KEYS[w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")];
        return (
          <span key={i} style={{display: "inline-block", margin: "0 9px", opacity: s > 0.01 ? 1 : 0,
            transform: `translateY(${(1 - s) * 40}px) scale(${0.55 + 0.45 * s})`, color: key ? COLORS[key] : "#fff"}}>{w}</span>
        );
      })}
    </div>
  );
};

const Card: React.FC<{at: number; out: number; top?: number; height?: number; children: React.ReactNode}> = ({at, out, top = 470, height = 640, children}) => {
  const {t, fps, frame} = useT();
  const s = pop(frame, fps, at, 13);
  const o = interpolate(t, [out - 0.2, out], [1, 0], clamp);
  return (
    <div style={{position: "absolute", left: 70, right: 70, top, height, borderRadius: 44, background: "rgba(255,255,255,.94)",
      boxShadow: "0 18px 50px rgba(0,0,0,.35)", fontFamily: FONT, color: "#151515", opacity: Math.min(s, o) ,
      transform: `translateY(${(1 - s) * 80}px) scale(${0.9 + 0.1 * s})`, overflow: "hidden"}}>{children}</div>
  );
};

// 0–3.5 s: hook — tumbling «Гора мятого белья?» sticker with a shake
const Hook: React.FC = () => {
  const {t, fps, frame} = useT();
  const s = pop(frame, fps, 0.05, 8);
  const wob = Math.sin(t * 18) * interpolate(t, [0.3, 1.2], [6, 0], clamp);
  const o = interpolate(t, [3.3, 3.5], [1, 0], clamp);
  const know = pop(frame, fps, 2.35, 7);
  return (
    <>
      <div style={{position: "absolute", left: 60, right: 60, top: 240, textAlign: "center", fontFamily: FONT, fontWeight: 900, fontSize: 92,
        background: "#FFD60A", color: "#111", borderRadius: 30, padding: "26px 20px", opacity: o * Math.min(1, s * 2),
        transform: `scale(${s}) rotate(${wob - 3}deg)`}}>Гора мятого белья? 😩</div>
      {t > 2.3 && t < 3.5 && (
        <div style={{position: "absolute", left: 0, right: 0, top: 700, textAlign: "center", fontFamily: FONT, fontWeight: 900, fontSize: 160,
          color: "#FFD60A", textShadow: "0 8px 0 #000,4px 0 0 #000,-4px 0 0 #000", transform: `scale(${0.3 + 0.7 * know}) rotate(${(1 - know) * -20}deg)`,
          opacity: know}}>ЗНАКОМО?</div>
      )}
    </>
  );
};

// 3.6–7.2 s: «без доски и утюга» — two items get crossed out
const NoBoard: React.FC = () => {
  const {t} = useT();
  const line = (at: number) => interpolate(t, [at, at + 0.35], [0, 1], {...clamp, easing: Easing.out(Easing.cubic)});
  const row = (label: string, icon: string, at: number, y: number) => (
    <div style={{position: "absolute", left: 60, right: 60, top: y, height: 200, display: "flex", alignItems: "center", fontSize: 84, fontWeight: 900}}>
      <span style={{fontSize: 120, marginRight: 40}}>{icon}</span>{label}
      <div style={{position: "absolute", left: 0, top: 96, height: 16, borderRadius: 8, background: "#FF4D4D", width: `${line(at) * 100}%`}} />
      <span style={{position: "absolute", right: 0, fontSize: 110, opacity: line(at + 0.2)}}>❌</span>
    </div>
  );
  return (
    <Card at={3.6} out={7.2} height={560}>
      <div style={{position: "absolute", top: 34, left: 0, right: 0, textAlign: "center", fontSize: 56, fontWeight: 800, color: "#FF7A1A"}}>Придумали, как гладить без…</div>
      {row("доски", "🪵", 4.9, 120)}
      {row("утюга", "🔥", 6.0, 330)}
    </Card>
  );
};

// 7.3–9.7 s: 9-second ring
const Timer: React.FC = () => {
  const {t} = useT();
  const p = interpolate(t, [7.4, 8.7], [0, 1], {...clamp, easing: Easing.out(Easing.quad)});
  const C = 2 * Math.PI * 140;
  return (
    <Card at={7.3} out={9.7} top={560} height={440}>
      <svg width={940} height={340} style={{position: "absolute", top: 10, left: 0}}>
        <circle cx={470} cy={170} r={140} fill="none" stroke="#eee" strokeWidth={28} />
        <circle cx={470} cy={170} r={140} fill="none" stroke="#FF7A1A" strokeWidth={28} strokeLinecap="round"
          transform="rotate(-90 470 170)" strokeDasharray={C} strokeDashoffset={C * (1 - p)} />
      </svg>
      <div style={{position: "absolute", top: 90, left: 0, right: 0, textAlign: "center", fontSize: 150, fontWeight: 900, color: "#FF7A1A",
        transform: `scale(${0.5 + 0.5 * p + (p >= 1 ? 0.08 * Math.sin((t - 8.7) * 12) : 0)})`}}>{Math.round(9 * p)}</div>
      <div style={{position: "absolute", bottom: 30, left: 0, right: 0, textAlign: "center", fontSize: 56, fontWeight: 800}}>секунд — и пар готов 💨</div>
    </Card>
  );
};

// 10.3–14.4 s: crease line straightens (wrinkled → smooth)
const Crease: React.FC = () => {
  const {t} = useT();
  const k = interpolate(t, [11.0, 13.6], [1, 0], {...clamp, easing: Easing.inOut(Easing.cubic)});
  const pts: string[] = [];
  for (let x = 0; x <= 800; x += 10) {
    const y = 190 + k * (60 * Math.sin(x / 23) + 35 * Math.sin(x / 9 + 1) + 20 * Math.sin(x / 4));
    pts.push(`${x + 70},${y.toFixed(1)}`);
  }
  const col = k > 0.5 ? "#FF4D4D" : "#3DDC84";
  return (
    <Card at={10.3} out={14.4} top={560} height={400}>
      <div style={{position: "absolute", top: 34, left: 0, right: 0, textAlign: "center", fontSize: 60, fontWeight: 900}}>
        {k > 0.05 ? "складки…" : "гладко ✨"}
      </div>
      <svg width={940} height={340} style={{position: "absolute", top: 40, left: 0}}>
        <polyline points={pts.join(" ")} fill="none" stroke={col} strokeWidth={22} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Card>
  );
};

// 14.6–17.9 s: checklist in sync with the voice
const Checklist: React.FC = () => {
  const {fps, frame} = useT();
  const items: [string, number][] = [["Простыня", 14.65], ["Футболка", 15.35], ["Рубашка", 16.15]];
  return (
    <Card at={14.5} out={17.9} height={560}>
      {items.map(([txt, at], i) => {
        const s = pop(frame, fps, at, 12);
        const c = pop(frame, fps, at + 0.15, 8);
        return (
          <div key={i} style={{position: "absolute", left: 60, top: 60 + i * 160, display: "flex", alignItems: "center", fontSize: 76, fontWeight: 900,
            opacity: s, transform: `translateX(${(1 - s) * -100}px)`}}>
            <div style={{width: 110, height: 110, borderRadius: 55, background: "#3DDC84", color: "#fff", display: "flex", alignItems: "center",
              justifyContent: "center", fontSize: 72, marginRight: 36, transform: `scale(${c})`}}>✓</div>{txt}
          </div>
        );
      })}
      <div style={{position: "absolute", bottom: 26, left: 0, right: 0, textAlign: "center", fontSize: 56, fontWeight: 800, color: "#FF7A1A"}}>пара минут на вещь</div>
    </Card>
  );
};

// 17.9–end: CTA — comment bubble types «ПАР», pulses; top plate
const Cta: React.FC = () => {
  const {t, fps, frame} = useT();
  const s = pop(frame, fps, 18.0, 9);
  const letters = "ПАР".split("");
  const pulse = t > 19.0 ? 1 + 0.06 * Math.sin((t - 19.0) * 9) : 1;
  return (
    <>
      <div style={{position: "absolute", left: 140, right: 140, top: 820, height: 200, borderRadius: 100, background: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, fontWeight: 900, fontSize: 120, color: "#FF7A1A",
        boxShadow: "0 14px 40px rgba(0,0,0,.4)", opacity: s, transform: `scale(${s * pulse})`}}>
        💬&nbsp;{letters.map((l, i) => <span key={i} style={{opacity: t > 18.35 + i * 0.16 ? 1 : 0}}>{l}</span>)}
      </div>
      <div style={{position: "absolute", left: 0, right: 0, top: 1050, textAlign: "center", fontFamily: FONT, fontWeight: 900, fontSize: 64,
        color: "#fff", textShadow: "0 4px 0 #000,2px 0 0 #000,-2px 0 0 #000", opacity: s, transform: `translateY(${Math.sin(t * 6) * 10}px)`}}>
        👇 напишите в комментариях
      </div>
    </>
  );
};

const TopCta: React.FC = () => {
  const {fps, frame} = useT();
  const s = pop(frame, fps, 10.3, 10);
  return (
    <div style={{position: "absolute", left: 60, right: 60, top: 250, textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: 70,
      background: "#FF7A1A", color: "#fff", borderRadius: 26, padding: "24px 20px", opacity: s, transform: `scale(${0.5 + 0.5 * s})`}}>
      Напишите «ПАР» в комментариях
    </div>
  );
};

export const Reel: React.FC = () => (
  <AbsoluteFill style={{background: "#000"}}>
    <Background />
    <CutFlash />
    <Window from={0} to={3.6}><Hook /></Window>
    <Window from={3.5} to={7.3}><NoBoard /></Window>
    <Window from={7.2} to={9.8}><Timer /></Window>
    <Window from={10.2} to={14.5}><Crease /></Window>
    <Window from={14.4} to={18.0}><Checklist /></Window>
    <Window from={10.2} to={30}><TopCta /></Window>
    <Window from={17.9} to={30}><Cta /></Window>
    <Captions />
  </AbsoluteFill>
);
