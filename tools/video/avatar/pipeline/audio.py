import json, subprocess, numpy as np, os, glob, sys
SR = 48000
P = json.load(open('/tmp/facework/reel02/plan.json'))
DUR = P['dur']; VID_LEN = (int(np.ceil(DUR * 30)) + 1) / 30   # video length (frames/30)
LIB = '/home/user/bikas-music/reels-basic/library/sfx/'
def dec(path):
    pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(pcm, np.float32).copy()
def wav(path, x, ch=1):
    import wave
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
def active_db(x, win=0.05, floor=-45):
    n = int(SR * win); m = len(x) // n
    if m == 0: return -90.0
    r = np.sqrt(np.mean(x[:m * n].reshape(m, n) ** 2, axis=1)); db = 20 * np.log10(r + 1e-9)
    a = r[db > floor]
    return 20 * np.log10(np.sqrt(np.mean(a ** 2)) + 1e-9) if len(a) else -90.0

# ---- voice: no denoise, only a gentle high-pass; scaled so that peaks stay under the 0.2 limiter ceiling
v = dec('/tmp/facework/reel02/v21.mp3'); v = v * (0.15 / np.max(np.abs(v)))
vp = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-af', 'highpass=f=100:poles=2,acompressor=threshold=0.08:ratio=2:attack=10:release=200:makeup=3', '-f', 'f32le', '-'],
                    input=v.tobytes(), capture_output=True).stdout
v = np.frombuffer(vp, np.float32).copy()
N = int(round(VID_LEN * SR)); vv = np.zeros(N, np.float32); vv[:min(N, len(v))] = v[:N]
V = active_db(vv); print('voice active rms dBFS', round(V, 1), 'peak', round(20 * np.log10(np.max(np.abs(vv))), 1))
wav('/tmp/facework/reel02/a_voice.wav', vv)

# ---- sfx
OFFS = {'boom': -11, 'click': -17, 'whoosh': -15, 'pop': -15, 'flash': -15, 'ding': -17, 'riser': -13}
POOL = {
 'whoosh': ['whoosh/_cuts/whoosh_9_02.wav', 'whoosh/_cuts/whoosh_11_05.wav', 'whoosh/_cuts/whoosh_8_02.wav', 'whoosh/_cuts/whoosh_5_02.wav', 'whoosh/_cuts/whoosh_7_02.wav', 'whoosh/_cuts/whoosh_11_10.wav', 'whoosh/_cuts/whoosh_12_01.wav', 'whoosh/_cuts/whoosh_4_02.wav'],
 'pop': ['click/pop_01.wav', 'click/pop_02.wav', 'click/cartoon_pop.mp3', 'click/plastic_pop.aac', 'click/bubble_pop.aac'],
 'click': ['click/select_2.mp3', 'click/button_click.mp3', 'click/user_interface_click_2.mp3', 'click/select_4.mp3', 'click/mechanical_click.mp3'],
 'flash': ['click/camera_flash.wav'],
 'boom': ['boom/boom_impact_4.mp3', 'boom/boom_low_hit.mp3', 'boom/boom_impact_2.mp3'],
 'ding': ['ding/ding_notification.wav', 'ding/check_mark.wav'],
 'riser': ['riser/riser_popular.wav'],
}
MAXLEN = {'whoosh': 0.85, 'click': 0.35, 'pop': 0.45, 'flash': 0.7, 'boom': 1.6, 'ding': 1.3, 'riser': 2.0}
FADE = {'whoosh': 0.3, 'click': 0.1, 'pop': 0.15, 'flash': 0.25, 'boom': 0.8, 'ding': 0.6, 'riser': 0.02}
used = {k: 0 for k in POOL}
sfx = np.zeros(N, np.float32); log = []
for t, kind, pr in sorted(P['sfx']):
    if kind == 'click' and (abs(t - 3.97) < 0.03 or abs(t - 41.9) < 0.03): continue
    path = POOL[kind][used[kind] % len(POOL[kind])]; used[kind] += 1
    x = dec(LIB + path)
    pk = np.max(np.abs(x)); on = int(np.argmax(np.abs(x) > 0.12 * pk))
    x = x[max(0, on - int(0.005 * SR)):]; on = min(on, int(0.005 * SR))
    L = int(MAXLEN[kind] * SR); x = x[:L].copy()
    f = int(FADE[kind] * SR); x[-f:] *= np.linspace(1, 0, min(f, len(x)))[:len(x[-f:])]
    L_db = active_db(x, 0.03, -50)
    g_db = float(max(-60, min(20, V + OFFS[kind] - L_db)))
    x = x * 10 ** (g_db / 20)
    if kind == 'riser': start = (44.97 - len(x) / SR)
    else: start = t - 0.06 - on / SR
    s0 = int(round(start * SR)); s0c = max(0, s0)
    seg = x[s0c - s0:]; e = min(N, s0c + len(seg)); sfx[s0c:e] += seg[:e - s0c]
    log.append((round(start, 2), kind, os.path.basename(path), round(g_db, 1)))
print(len(log), 'sfx'); [print(l) for l in log]
wav('/tmp/facework/reel02/a_sfx.wav', sfx)
json.dump(dict(V=float(V), log=log), open('/tmp/facework/reel02/audio_log.json', 'w'))
