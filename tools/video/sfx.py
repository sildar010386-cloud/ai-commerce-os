"""Synthesize short sound effects for motion-graphic reels (free, no API; test 2026-10-15).

  python3 tools/video/sfx.py OUT_DIR

Writes whoosh, whoosh_hit, pop, ding, buzz, tick_rise, hiss, sparkle, swipe, typing (.wav, mono 44.1 kHz).
The ElevenLabs key in this environment has no sound_generation permission; when the owner enables it,
generated effects can replace these files under the same names.
"""
import os, sys, wave
import numpy as np

SR = 44100
rng = np.random.default_rng(7)


def save(path, x):
    x = np.clip(x / (np.max(np.abs(x)) + 1e-9) * 0.9, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype(np.int16).tobytes())


def t(d):
    return np.arange(int(SR * d)) / SR


def lp(x, a):
    """One-pole lowpass with a per-sample coefficient array a in (0, 1)."""
    y, s = np.zeros_like(x), 0.0
    for i in range(len(x)):
        s += a[i] * (x[i] - s); y[i] = s
    return y


def main(out):
    os.makedirs(out, exist_ok=True)
    p = lambda n: os.path.join(out, n + ".wav")
    d = 0.5; n = int(SR * d); tt = t(d)
    a = 0.02 + 0.25 * np.sin(np.pi * tt / d) ** 2
    wh = (lp(rng.standard_normal(n), a) - 0.5 * lp(rng.standard_normal(n), a * 0.2)) * np.sin(np.pi * tt / d) ** 1.5
    save(p("whoosh"), wh)
    d = 1.0; n = int(SR * d); tt = t(d); k = int(SR * 0.42); ti = tt[:n - k]
    imp = np.zeros(n)
    imp[k:] = np.sin(2 * np.pi * (55 + 40 * np.exp(-ti * 20)) * ti) * np.exp(-ti * 7) + 0.4 * rng.standard_normal(n - k) * np.exp(-ti * 30)
    save(p("whoosh_hit"), np.concatenate([wh, np.zeros(n - len(wh))]) * 0.7 + imp)
    tt = t(0.25); f = 900 * np.exp(-tt * 25) + 180
    save(p("pop"), np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 22))
    tt = t(0.9)
    save(p("ding"), (np.sin(2 * np.pi * 1318 * tt) + 0.5 * np.sin(2 * np.pi * 2637 * tt) + 0.25 * np.sin(2 * np.pi * 3951 * tt))
         * np.exp(-tt * 5) * np.minimum(tt / 0.004, 1))
    tt = t(0.4)
    save(p("buzz"), (0.6 * np.sign(np.sin(2 * np.pi * 110 * tt)) + 0.4 * np.sign(np.sin(2 * np.pi * 116 * tt))) * np.exp(-tt * 2))
    d = 1.15; x = np.zeros(int(SR * d)); c, gap, i = 0.0, 0.16, 0
    while c < d - 0.05:
        k = int(c * SR); m = int(0.012 * SR); tc = np.arange(m) / SR
        x[k:k + m] += np.sin(2 * np.pi * (2000 + i * 60) * tc) * np.exp(-tc * 600)
        c += gap; gap = max(0.045, gap * 0.85); i += 1
    save(p("tick_rise"), x)
    d = 1.2; n = int(SR * d); nz = rng.standard_normal(n); tt = t(d)
    save(p("hiss"), (nz - lp(nz, np.full(n, 0.15))) * np.minimum(tt / 0.05, 1) * np.exp(-np.maximum(tt - 0.05, 0) / 0.35))
    x = np.zeros(int(SR * 0.9))
    for i in range(9):
        c = 0.05 + i * 0.08 + rng.uniform(0, 0.03); f = rng.uniform(2500, 5200); m = int(0.18 * SR); tc = np.arange(m) / SR; k = int(c * SR)
        x[k:k + m] += np.sin(2 * np.pi * f * tc) * np.exp(-tc * 28) * (1 - i / 12)
    save(p("sparkle"), x)
    d = 0.35; n = int(SR * d); tt = t(d)
    save(p("swipe"), lp(rng.standard_normal(n), 0.05 + 0.5 * (tt / d)) * np.sin(np.pi * tt / d))
    x = np.zeros(int(SR * 0.6))
    for c in (0.0, 0.16, 0.32):
        k = int(c * SR); m = int(0.03 * SR); tc = np.arange(m) / SR
        x[k:k + m] += rng.standard_normal(m) * np.exp(-tc * 250) + 0.5 * np.sin(2 * np.pi * 1800 * tc) * np.exp(-tc * 400)
    save(p("typing"), x)
    print("sfx ->", out)


if __name__ == "__main__":
    main(sys.argv[1])
