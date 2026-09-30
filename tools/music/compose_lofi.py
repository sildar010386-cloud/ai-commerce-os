"""Compose an original royalty-free lo-fi background bed (no samples, no third-party audio).

Usage: compose_lofi.py OUT.wav DURATION_SEC [BPM] [SEED]
"""
import sys, wave
import numpy as np

SR = 44100


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def env_exp(n, tau, attack=0.005):
    t = np.arange(n) / SR
    a = np.minimum(1, t / attack) if attack > 0 else 1
    return a * np.exp(-t / tau)


def epiano(f, dur, vel):
    n = int(dur * SR); t = np.arange(n) / SR
    e = env_exp(n, 1.1, 0.004)
    mod = 0.9 * np.exp(-t / 0.35) * np.sin(2 * np.pi * f * 2 * t)
    x = np.sin(2 * np.pi * f * t + mod) + 0.25 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t / 0.4)
    return vel * e * x


def pad(f, dur, vel):
    n = int(dur * SR); t = np.arange(n) / SR
    a = np.minimum(1, t / 0.6) * np.minimum(1, (dur - t) / 0.5).clip(0)
    l = np.sin(2 * np.pi * f * 0.998 * t) + 0.3 * np.sin(2 * np.pi * f * 2.003 * t)
    r = np.sin(2 * np.pi * f * 1.002 * t) + 0.3 * np.sin(2 * np.pi * f * 1.997 * t)
    return vel * a * l, vel * a * r


def bass(f, dur, vel):
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.tanh(1.5 * (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t)))
    return vel * env_exp(n, 0.45, 0.008) * x


def kick(vel):
    n = int(0.35 * SR); t = np.arange(n) / SR
    f = 50 + 70 * np.exp(-t / 0.04)
    return vel * np.exp(-t / 0.12) * np.sin(2 * np.pi * np.cumsum(f) / SR)


def snare(vel, rng):
    n = int(0.25 * SR); t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    noise = np.convolve(noise, np.ones(6) / 6, "same") - np.convolve(noise, np.ones(40) / 40, "same")
    return vel * (0.8 * np.exp(-t / 0.07) * noise + 0.4 * np.exp(-t / 0.05) * np.sin(2 * np.pi * 185 * t))


def hat(vel, rng):
    n = int(0.06 * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n); x = x - np.convolve(x, np.ones(4) / 4, "same")
    return vel * np.exp(-t / 0.015) * x


def add(buf, x, start):
    i = int(start * SR)
    if i >= buf.shape[-1]:
        return
    x = x[: buf.shape[-1] - i]
    buf[..., i:i + len(x)] += x


def compose(dur, bpm=96, seed=7):
    rng = np.random.default_rng(seed)
    beat = 60 / bpm; bar = 4 * beat
    L = np.zeros(int((dur + 3) * SR)); R = np.zeros_like(L)
    chords = [(48, [60, 64, 67, 71]), (52, [59, 62, 64, 67]), (45, [60, 64, 67, 69]), (41, [57, 60, 64, 69])]
    melody = [[76, None, 74, 72], [71, None, 74, None], [72, 76, None, 79], [77, None, 76, 72]]
    nbars = int(np.ceil(dur / bar))
    for b in range(nbars):
        t0 = b * bar
        last = b == nbars - 1
        root, notes = chords[0] if last else chords[b % 4]
        for n in notes:
            pl, pr = pad(midi(n), bar + 0.3, 0.035)
            add(L, pl, t0); add(R, pr, t0)
            add(L, epiano(midi(n), bar, 0.05), t0 + 0.01 * (n % 3))
            add(R, epiano(midi(n), bar, 0.05), t0 + 0.012 * (n % 2))
            if not last:
                ep = epiano(midi(n), 2 * beat, 0.028)
                add(L, ep, t0 + 2.5 * beat); add(R, ep, t0 + 2.5 * beat)
        bl = bass(midi(root), 1.4 * beat, 0.22)
        for pos in ([0] if last else [0, 1.5, 2.5]):
            add(L, bl, t0 + pos * beat); add(R, bl, t0 + pos * beat)
        if last:
            continue
        for q in range(4):
            kpos = [0, 2.5] if b % 2 else [0, 2, 2.75]
        for pos in kpos:
            k = kick(0.35); add(L, k, t0 + pos * beat); add(R, k, t0 + pos * beat)
        for pos in (1, 3):
            s = snare(0.12, rng); add(L, s, t0 + pos * beat); add(R, s, t0 + pos * beat)
        for e in range(8):
            swing = 0.08 * beat if e % 2 else 0
            h = hat(0.05 if e % 2 else 0.035, rng)
            add(L, 0.7 * h, t0 + e * beat / 2 + swing); add(R, 1.0 * h, t0 + e * beat / 2 + swing)
        if b >= 1:
            for i, n in enumerate(melody[b % 4]):
                if n:
                    m = epiano(midi(n), beat * 1.5, 0.045)
                    add(L, 0.8 * m, t0 + i * beat); add(R, m, t0 + i * beat)
    n = int(dur * SR)
    out = np.stack([L[:n], R[:n]])
    fade_in, fade_out = int(0.25 * SR), int(2.0 * SR)
    out[:, :fade_in] *= np.linspace(0, 1, fade_in)
    out[:, -fade_out:] *= np.linspace(1, 0, fade_out) ** 1.5
    return out / (np.abs(out).max() + 1e-9) * 0.89


def write(path, x):
    pcm = (np.clip(x.T, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    out, dur = sys.argv[1], float(sys.argv[2])
    bpm = float(sys.argv[3]) if len(sys.argv) > 3 else 96
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 7
    write(out, compose(dur, bpm, seed))
