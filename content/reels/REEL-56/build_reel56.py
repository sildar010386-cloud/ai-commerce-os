"""REEL-56 montage: python3 build_reel56.py WORKDIR
WORKDIR must hold: w/up1.mp4, w/up2.mp4 (raw-03 clips 31/32 upscaled to 1080x1920 30 fps),
voice/v56.mp3 + v56.json (ElevenLabs owner2 with timestamps), sfx/*.wav (tools/video/sfx.py), music file path in MUSIC.
"""
import json, os, subprocess, sys

D = sys.argv[1]
MUSIC = "/home/user/bikas-music/" + "moodmode-no-copyright-music-201745.mp3"
FONT = "/home/user/bikas-music/reels-basic/library/brand/fonts/Montserrat/static"
FPS = 30
GAP = 0.15  # silence kept between sentences after cutting the voice pauses

# (clip, source start, duration) ; output times follow the voice
SEGS = [("1", 8.0, 3.4), ("1", 12.5, 2.5), ("1", 16.8, 2.2), ("1", 20.2, 2.5), ("1", 24.0, 2.55),
        ("2", 7.8, 2.25), ("2", 11.8, 2.25), ("1", 32.0, 3.3)]

def sh(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(" ".join(cmd)); print(r.stderr[-1500:]); sys.exit(1)
    return r.stderr

# ---------- voice: cut sentence pauses ----------
al = json.load(open(f"{D}/voice/v56.json"))
words, cur, s, e = [], "", 0, 0
for c, a, b in zip(al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]):
    if c == " ":
        if cur: words.append([cur, s, e]); cur = ""
        continue
    if not cur: s = a
    cur += c; e = b
words.append([cur, s, e])
sent_starts = [i for i, w in enumerate(words) if i == 0 or words[i - 1][0][-1] in ".?"]
pieces = []  # (src_start, src_end, out_start)
out_t = 0.0
for k, i0 in enumerate(sent_starts):
    i1 = (sent_starts[k + 1] if k + 1 < len(sent_starts) else len(words)) - 1
    a = max(0, words[i0][1] - 0.05); b = words[i1][2] + 0.08
    pieces.append((a, b, out_t)); out_t += (b - a) + GAP
vdur_end = out_t - GAP
def remap(t):
    for a, b, o in pieces:
        if a - 0.06 <= t <= b + 0.01: return o + (t - a)
    return None
nw = [[w, remap(s0 + 1e-4), remap(e0 - 1e-4)] for w, s0, e0 in words]
TOTAL = round(vdur_end + 0.6, 2)
fc = ";".join(f"[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS[p{i}]" for i, (a, b, o) in enumerate(pieces))
fc += ";" + "".join(f"[p{i}]" + (f"aevalsrc=0:d={GAP}:s=44100[g{i}];[g{i}]" if False else "") for i in range(len(pieces)))
# simple: concat pieces with explicit silences
parts = []
for i in range(len(pieces)):
    parts.append(f"[p{i}]")
    if i < len(pieces) - 1: parts.append(f"[g{i}]")
fc = ";".join(f"[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,aresample=44100[p{i}]" for i, (a, b, o) in enumerate(pieces))
fc += ";" + ";".join(f"anullsrc=r=44100:cl=mono,atrim=0:{GAP},asetpts=PTS-STARTPTS[g{i}]" for i in range(len(pieces) - 1))
fc += f";{''.join(parts)}concat=n={len(parts)}:v=0:a=1,apad=whole_dur={TOTAL}[v]"
sh(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{D}/voice/v56.mp3", "-filter_complex", fc, "-map", "[v]", "-t", str(TOTAL), "-ar", "44100", "-ac", "1", f"{D}/voice_cut.wav"])
json.dump(nw, open(f"{D}/words_out.json", "w"), ensure_ascii=False)

# ---------- video ----------
tot_seg = sum(s[2] for s in SEGS)
print("segments total", tot_seg, "voice end", vdur_end, "TOTAL", TOTAL)
fcv, labs = [], []
for i, (clip, ss, dur) in enumerate(SEGS):
    nfr = round(dur * FPS)
    z0, z1 = (1.0, 1.06) if i % 2 == 0 else (1.06, 1.0)
    fcv.append(f"[{0 if clip=='1' else 1}:v]trim=start={ss}:duration={dur + 0.1},setpts=PTS-STARTPTS,"
               f"scale=w='1080*({z0}+({z1}-{z0})*t/{dur})':h=-2:eval=frame,crop=1080:1920,setsar=1,fps={FPS},trim=end_frame={nfr},setpts=PTS-STARTPTS[s{i}]")
    labs.append(f"[s{i}]")
fcv.append("".join(labs) + f"concat=n={len(SEGS)}:v=1:a=0,tpad=stop_mode=clone:stop_duration=2,trim=duration={TOTAL},eq=contrast=1.03:saturation=1.05[v]")
sh(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{D}/w/up1.mp4", "-i", f"{D}/w/up2.mp4", "-filter_complex", ";".join(fcv),
    "-map", "[v]", "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-pix_fmt", "yuv420p", f"{D}/video_plain.mp4"])

# ---------- ASS: title (whole reel), word captions, CTA ----------
def ts(t):
    t = max(t, 0); return f"{int(t//3600)}:{int(t%3600//60):02d}:{t%60:05.2f}"
ev = []
TITLE = r"Если бомбер помялся,\Nне гладьте его\Nутюгом"
cta_start = nw[-2][1] - 0.15  # at "Напишите"
for w, a, b in nw:
    if a is None or a >= cta_start - 0.2: continue
    txt = w.strip(".,?").upper() if False else w.rstrip(",.?")
    ev.append(f"Dialogue: 1,{ts(a)},{ts(b + 0.06)},Word,,0,0,0,,{txt}")
ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Title,Montserrat Black,104,&H1409E5,&H1409E5,&HFFFFFF,&H80000000,0,0,0,0,100,100,0,0,1,9,4,8,60,60,300,1
Style: Word,Montserrat ExtraBold,100,&HFFFFFF,&HFFFFFF,&H000000,&H80000000,0,0,0,0,100,100,0,0,1,8,3,2,60,60,300,1
Style: Cta,Montserrat Black,112,&HFFFFFF,&HFFFFFF,&H1409E5,&H80000000,0,0,0,0,100,100,0,0,1,10,4,5,60,60,0,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
""" + "\n".join(ev) + "\n"
open(f"{D}/reel56.ass", "w").write(ass)
# plates (rounded white box, red text, soft shadow) rendered with PIL
from PIL import Image, ImageDraw, ImageFilter, ImageFont
RED = (229, 9, 20)
def plates(lines, size, top, colors, path, pad=(34, 14), gap=18, radius=34):
    f = ImageFont.truetype(f"{FONT}/Montserrat-Black.ttf", size)
    img = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0)); sh_l = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0))
    d, ds = ImageDraw.Draw(img), ImageDraw.Draw(sh_l)
    y = top
    asc, desc = f.getmetrics()
    for ln, col in zip(lines, colors):
        w = d.textlength(ln, font=f); bw, bh = w + 2 * pad[0], asc + desc + 2 * pad[1]
        x0 = (1080 - bw) / 2
        ds.rounded_rectangle((x0 + 4, y + 8, x0 + bw + 4, y + bh + 8), radius, fill=(0, 0, 0, 120))
        d.rounded_rectangle((x0, y, x0 + bw, y + bh), radius, fill=(255, 255, 255, 255))
        d.text((x0 + pad[0], y + pad[1]), ln, font=f, fill=col)
        y += bh + gap
    sh_l = sh_l.filter(ImageFilter.GaussianBlur(9))
    Image.alpha_composite(sh_l, img).save(path)
    return y
plates(["Если бомбер помялся,", "не гладьте его", "утюгом"], 70, 270, [RED] * 3, f"{D}/title.png", pad=(30, 12))
plates(["Напишите", "«ПАР»", "в комментариях"], 96, 760, [(20, 20, 20), RED, (20, 20, 20)], f"{D}/cta.png")
sh(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{D}/video_plain.mp4", "-i", f"{D}/title.png", "-i", f"{D}/cta.png",
    "-filter_complex", f"[0:v][1:v]overlay=0:0[a];[a][2:v]overlay=0:0:enable='gte(t,{cta_start})'[b];[b]ass={D}/reel56.ass:fontsdir={FONT}[v]",
    "-map", "[v]", "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30", f"{D}/video_text.mp4"])

# ---------- audio mix ----------
# SFX: (name, time, gain) ; placed ~60 ms before the cut
cuts = [sum(s[2] for s in SEGS[:k]) for k in range(len(SEGS))]
SFX = [("whoosh", cuts[1] - 0.06, 0.30), ("whoosh", cuts[3] - 0.06, 0.28),
       ("whoosh_hit", cuts[5] - 0.06, 0.32), ("hiss", cuts[5] + 0.5, 0.22), ("ding", cta_start, 0.18)]
json.dump(SFX, open(f"{D}/sfx_used.json", "w"))
cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", f"{D}/voice_cut.wav", "-stream_loop", "-1", "-ss", "4", "-i", MUSIC]
for fx, at, g in SFX: cmd += ["-i", f"{D}/sfx/{fx}.wav"]
f = [f"[0:a]loudnorm=I=-16:TP=-2:LRA=7,aresample=44100,apad=whole_dur={TOTAL},atrim=0:{TOTAL},asplit=2[vo][vsc]",
     f"[1:a]atrim=0:{TOTAL},asetpts=PTS-STARTPTS,loudnorm=I=-20:TP=-2,highpass=f=45,equalizer=f=1500:t=q:w=1:g=-4,volume=0.55,afade=t=in:d=0.3,afade=t=out:st={TOTAL-1.8}:d=1.8[m0]",
     "[m0][vsc]sidechaincompress=threshold=0.06:ratio=3:attack=30:release=400[m]"]
labs = ["[vo]", "[m]"]
for k, (fx, at, g) in enumerate(SFX):
    ms = int(at * 1000)
    f.append(f"[{k+2}:a]aresample=44100,pan=mono|c0=c0,adelay={ms},volume={g}[x{k}]"); labs.append(f"[x{k}]")
f.append("".join(labs) + f"amix=inputs={len(labs)}:normalize=0:duration=first,alimiter=limit=0.85[a]")
sh(cmd + ["-filter_complex", ";".join(f), "-map", "[a]", "-t", str(TOTAL), "-ar", "48000", f"{D}/mix.wav"])
# two-pass loudnorm -14
st = sh(["ffmpeg", "-hide_banner", "-i", f"{D}/mix.wav", "-af", "loudnorm=I=-14:TP=-1:LRA=7:print_format=json", "-f", "null", "-"])
m = json.loads(st[st.rindex("{"):st.rindex("}") + 1])
ln = (f"loudnorm=I=-14:TP=-1:LRA=7:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
      f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
sh(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{D}/video_text.mp4", "-i", f"{D}/mix.wav", "-af", ln, "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-t", str(TOTAL), "-movflags", "+faststart", f"{D}/REEL-56.mp4"])
print("done", TOTAL)
