"""Lay sound effects over a finished reel at given times (motion-graphics test 2026-10-15).

  python3 tools/video/add_sfx.py IN.mp4 SPEC_JSON NAME SFX_DIR OUT.mp4

The spec entry may carry "sfx": [[effect_name, seconds, gain], ...]; effects are SFX_DIR/<effect_name>.wav
(tools/video/sfx.py). Video is copied; voice and music stay at their level, effects are added on top.
"""
import json, subprocess, sys

src, spec_path, name, sfx_dir, out = sys.argv[1:6]
items = json.load(open(spec_path))[name].get("sfx", [])
cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", src]
parts, labels = [], ["[0:a]"]
for k, (fx, at, gain) in enumerate(items, 1):
    cmd += ["-i", f"{sfx_dir}/{fx}.wav"]
    ms = int(at * 1000)
    parts.append(f"[{k}:a]aresample=44100,pan=stereo|c0=c0|c1=c0,adelay={ms}|{ms},volume={gain}[s{k}]")
    labels.append(f"[s{k}]")
fc = ";".join(parts + [f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:duration=first,alimiter=limit=0.95:level=disabled[a]"])
cmd += ["-filter_complex", fc, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]
subprocess.run(cmd, check=True)
print(out, len(items), "effects")
