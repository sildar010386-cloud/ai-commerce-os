"""Build a catalog of background tracks: duration, BPM estimate, loudness, brightness, intro level.

Usage: catalog.py MUSIC_DIR OUT.json
"""
import json, os, re, subprocess, sys
import numpy as np

SR = 22050


def load(path):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
                         capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


def lufs(path):
    out = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-af", "ebur128", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", out)
    return float(m[-1]) if m else None


def bpm(x):
    hop, win = 512, 1024
    frames = np.lib.stride_tricks.sliding_window_view(x[: len(x) // hop * hop], win)[::hop]
    spec = np.abs(np.fft.rfft(frames * np.hanning(win), axis=1))
    flux = np.maximum(0, np.diff(np.log1p(spec), axis=0)).sum(axis=1)
    flux -= flux.mean()
    ac = np.correlate(flux, flux, "full")[len(flux) - 1:]
    fps = SR / hop
    lags = np.arange(len(ac)) / fps
    ok = (lags > 60 / 170) & (lags < 60 / 70)
    lag = lags[ok][np.argmax(ac[ok])]
    return round(60 / lag, 1)


def analyse(path):
    x = load(path)
    dur = len(x) / SR
    seg = x[: SR * 60]
    spec = np.abs(np.fft.rfft(seg[: SR * 30]))
    f = np.fft.rfftfreq(len(seg[: SR * 30]), 1 / SR)
    centroid = float((spec * f).sum() / spec.sum())
    rms = lambda s: 20 * np.log10(np.sqrt(np.mean(s ** 2)) + 1e-9)
    per_sec = [rms(x[i:i + SR]) for i in range(0, len(x) - SR, SR)]
    return {"file": os.path.basename(path), "duration": round(dur, 1), "bpm": float(bpm(seg)), "lufs": lufs(path),
            "brightness_hz": round(centroid), "intro_3s_db": round(float(rms(x[: 3 * SR])), 1),
            "avg_db": round(float(np.mean(per_sec)), 1), "quiet_seconds": int(sum(1 for v in per_sec if v < -40))}


if __name__ == "__main__":
    d, out = sys.argv[1], sys.argv[2]
    rows = [analyse(os.path.join(d, n)) for n in sorted(os.listdir(d)) if n.lower().endswith((".mp3", ".wav", ".m4a"))]
    json.dump(rows, open(out, "w"), ensure_ascii=False, indent=1)
    for r in rows:
        print(f"{r['file'][:52]:52} {r['duration']:6} bpm {r['bpm']:5} lufs {r['lufs']} bright {r['brightness_hz']} intro {r['intro_3s_db']} avg {r['avg_db']} quiet {r['quiet_seconds']}")
