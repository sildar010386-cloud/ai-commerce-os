"""Assemble 9:16 videos from raw clips, voice parts and burned ASS subtitles."""
import json
import math
import os
import subprocess
import sys

RAW = os.environ.get("RAW_DIR", "raw")  # folder with the downloaded release assets
STRESS = "\u0301"  # combining acute accent used in voice texts to force stress
DISPLAY = {"Ватсап": "WhatsApp"}  # spoken spelling -> subtitle spelling
W, H, FPS = 1080, 1920, 30
FONT = "Liberation Sans"


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(" ".join(cmd)); print(r.stderr[-2000:]); sys.exit(1)


def render_segment(seg, out):
    clip, ss, dur = seg["clip"], seg["ss"], seg["dur"]
    speed = seg.get("speed", 1.0)
    src = f"{RAW}/{clip}.MOV"
    if seg.get("mode") == "blur":
        vf = (f"setpts=PTS/{speed},fps={FPS},split[a][b];"
              f"[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=30:2[bg];"
              f"[b]scale={W}:-2[fg];[bg][fg]overlay=0:(H-h)/2,setsar=1")
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(ss), "-t", str(dur * speed), "-i", src,
             "-filter_complex", vf, "-an", "-t", str(dur), "-c:v", "libx264", "-crf", "16", "-preset", "fast",
             "-pix_fmt", "yuv420p", out])
    elif seg.get("mode") == "split":
        # before/after: two stills stacked vertically, centre band of each frame
        a, b = seg["before"], seg["after"]
        vf = (f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H // 2}:0:{int(H * seg.get('crop_y', 0.25))}[t];"
              f"[1:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H // 2}:0:{int(H * seg.get('crop_y', 0.25))}[u];"
              f"[t][u]vstack,drawbox=x=0:y={H // 2 - 4}:w={W}:h=8:color=white:t=fill,fps={FPS},setsar=1")
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(a), "-i", src, "-ss", str(b), "-i", src,
             "-filter_complex", vf.replace("[0:v]", "[0:v]trim=end_frame=1,loop=-1:1,")
             .replace("[1:v]", "[1:v]trim=end_frame=1,loop=-1:1,"),
             "-an", "-t", str(dur), "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-pix_fmt", "yuv420p", out])
    else:
        vf = (f"setpts=PTS/{speed},fps={FPS},scale={W}:{H}:force_original_aspect_ratio=increase,"
              f"crop={W}:{H},setsar=1")
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(ss), "-t", str(dur * speed), "-i", src,
             "-vf", vf, "-an", "-t", str(dur), "-c:v", "libx264", "-crf", "16", "-preset", "fast",
             "-pix_fmt", "yuv420p", out])


def words_of(part):
    a = json.load(open(part + ".json"))
    words, cur, s, e = [], "", 0.0, 0.0
    for c, t0, t1 in zip(a["characters"], a["character_start_times_seconds"], a["character_end_times_seconds"]):
        if c == STRESS:
            continue
        if c == " ":
            if cur:
                words.append([cur, s, e]); cur = ""
            continue
        if not cur:
            s = t0
        cur += c; e = t1
    if cur:
        words.append([cur, s, e])
    for w in words:
        for k, v in DISPLAY.items():
            w[0] = w[0].replace(k, v)
    merged = []
    for w in words:  # attach a lone dash to the previous word
        if w[0] in ("—", "-") and merged:
            merged[-1][0] += " —"; merged[-1][2] = w[2]
        else:
            merged.append(w)
    return merged


def chunks(words, max_words=4, max_chars=22):
    out, cur = [], []
    for w in words:
        cur.append(w)
        text = " ".join(x[0] for x in cur)
        short = len(w[0]) <= 2 and w[0][-1] not in ".,?!—"
        if not short and (len(cur) >= max_words or len(text) >= max_chars or w[0][-1] in ".,?!—"):
            out.append(cur); cur = []
    if cur:
        out.append(cur)
    return out


def ts(t):
    t = max(t, 0)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


HEADER = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,{FONT},74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,6,2,2,90,90,560,1
Style: Hook,{FONT},82,&H00FFFFFF,&H00FFFFFF,&H28000000,&H00000000,1,0,0,0,100,100,0,0,3,18,0,8,80,80,300,1
Style: Cta,{FONT},70,&H00FFFFFF,&H00FFFFFF,&H001E6BF2,&H00000000,1,0,0,0,100,100,0,0,3,16,0,8,80,80,300,1
Style: Label,{FONT},96,&H00FFFFFF,&H00FFFFFF,&H28000000,&H00000000,1,0,0,0,100,100,0,0,3,16,0,5,60,60,0,1
Style: Timer,{FONT},104,&H0000D7FF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,7,2,7,70,70,620,1
Style: Small,{FONT},44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,4,1,7,74,70,740,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def envelope(path, hop=0.1):
    """RMS level in dB per `hop` seconds of the file's audio."""
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-vn", "-f", "s16le", "-ac", "1",
                          "-ar", "16000", "-"], capture_output=True).stdout
    n = int(16000 * hop)
    out = []
    for i in range(0, len(raw) // 2 - n, n):
        chunk = memoryview(raw)[i * 2:(i + n) * 2].cast("h")
        rms = (sum(v * v for v in chunk) / n) ** 0.5 / 32768
        out.append(20 * math.log10(rms + 1e-9))
    return out


def verify_audio(track, video, voice):
    """Fail if the video lost voice (dropouts) or has sound where the voice track is silent (overlaps)."""
    a, b = envelope(track), envelope(video)
    if abs(len(a) - len(b)) > 2:
        sys.exit(f"audio length mismatch: track {len(a)} vs video {len(b)} frames")
    lost = [i for i, (x, y) in enumerate(zip(a, b)) if x > -35 and y < -50]
    extra = [i for i, (x, y) in enumerate(zip(a, b)) if x < -60 and y > -35]
    if lost or extra:
        sys.exit(f"audio check failed: lost voice at {[i / 10 for i in lost[:5]]}s, extra sound at {[i / 10 for i in extra[:5]]}s")
    for part, st in voice:
        end = st + json.load(open(part + ".json"))["character_end_times_seconds"][-1]
        tail = b[int(end * 10) - 5:int(end * 10) - 1]
        if not tail or max(tail) < -45:
            sys.exit(f"audio check failed: end of voice part {part} (~{end:.1f}s) is silent in the video")
    print("audio check ok")


def build(name, spec):
    os.makedirs(f"seg_{name}", exist_ok=True)
    segs = spec["segments"]
    for i, seg in enumerate(segs):
        render_segment(seg, f"seg_{name}/{i:02d}.mp4")
    total = sum(s["dur"] for s in segs)
    with open(f"seg_{name}/list.txt", "w") as f:
        for i in range(len(segs)):
            f.write(f"file '{i:02d}.mp4'\n")

    ev = []
    for text, t0, t1, style in spec.get("texts", []):
        pos = ""
        if style == "Label" and len(text) > 1 and text[0] == "@":  # "@y|text": label at a y position
            y, text = text[1:].split("|", 1)
            pos = f"{{\\pos({W // 2},{y})}}"
        ev.append(f"Dialogue: 1,{ts(t0)},{ts(min(t1, total))},{style},,0,0,0,,{pos}{text}")
    vparts = spec.get("voice", [])
    for k, (part, start) in enumerate(vparts):
        limit = vparts[k + 1][1] - 0.05 if k + 1 < len(vparts) else total
        if not spec.get("subs", True):
            break
        cs = chunks(words_of(part))
        for j, c in enumerate(cs):
            t0 = start + c[0][1]
            t1 = start + (cs[j + 1][0][1] if j + 1 < len(cs) else c[-1][2] + 0.35)
            t1 = min(t1, limit)
            ev.append(f"Dialogue: 0,{ts(t0)},{ts(t1)},Sub,,0,0,0,,{' '.join(w[0] for w in c)}")
    if "timer" in spec:
        tm = spec["timer"]  # real-time seconds shown, piecewise by segment speed
        t, real = 0.0, 0.0
        for s in segs:
            step = 1.0 / FPS * 3
            tt = 0.0
            while tt < s["dur"] - 1e-6 and t + tt < tm["until"]:
                sec = int(real + tt * s.get("speed", 1.0))
                ev.append(f"Dialogue: 2,{ts(t + tt)},{ts(t + tt + step)},Timer,,0,0,0,,0:{sec:02d}")
                tt += step
            real += s["dur"] * s.get("speed", 1.0)
            t += s["dur"]
        if tm.get("note"):
            ev.append(f"Dialogue: 2,{ts(tm['note_from'])},{ts(tm['until'])},Small,,0,0,0,,{tm['note']}")
    open(f"{name}.ass", "w").write(HEADER + "\n".join(ev) + "\n")

    # Voice track is rendered on its own first (amix once dropped a trailing part silently),
    # then muxed, then the muxed audio is checked against it.
    voice = spec.get("voice", [])
    track = f"voice_{name}.wav"
    if voice:
        vcmd = ["ffmpeg", "-y", "-loglevel", "error"]
        for part, _ in voice:
            vcmd += ["-i", part + ".mp3"]
        fa = "".join(f"[{k}:a]adelay={int(st * 1000)}:all=1,apad=whole_dur={total:.3f}[v{k}];"
                     for k, (_, st) in enumerate(voice))
        mix = "".join(f"[v{k}]" for k in range(len(voice)))
        mix += f"amix=inputs={len(voice)}:normalize=0:duration=longest," if len(voice) > 1 else "anull,"
        vcmd += ["-filter_complex", fa + mix + "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=44100[a]",
                 "-map", "[a]", "-t", f"{total:.3f}", "-ac", "1", track]
    else:
        vcmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                "-t", f"{total:.3f}", track]
    run(vcmd)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", f"seg_{name}/list.txt",
           "-i", track, "-filter_complex",
           # "burn": false -> clean video; captions and plates are added by tools/video/hyperframes/captions.py
           f"[0:v]ass={name}.ass[vout]" if spec.get("burn", True) else "[0:v]null[vout]", "-map", "[vout]", "-map", "1:a",
           "-t", f"{total:.3f}", "-r", str(FPS), "-c:v", "libx264", "-crf", "19", "-maxrate", "7000k",
           "-bufsize", "12000k", "-preset", "medium", "-profile:v", "high", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", f"out/{spec['file']}"]
    os.makedirs("out", exist_ok=True)
    run(cmd)
    if voice:
        verify_audio(track, f"out/{spec['file']}", voice)
    print(name, f"{total:.1f}s", spec["file"])


if __name__ == "__main__":
    specs = json.load(open(os.environ.get("SPECS", "specs.json")))
    for n in (sys.argv[1:] or specs):
        build(n, specs[n])
