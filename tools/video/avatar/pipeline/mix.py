import json, subprocess, numpy as np, sys
SR = 48000
A = json.load(open('audio_log.json')); V = A['V']
MUS = '/home/user/bikas-music/andriig-background-music-background-604062.mp3'
VL = 46.4333
def dec(path):
    pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(pcm, np.float32).copy()
def active_db(x, win=0.05, floor=-70):
    n = int(SR * win); m = len(x) // n
    r = np.sqrt(np.mean(x[:m * n].reshape(m, n) ** 2, axis=1)); db = 20 * np.log10(r + 1e-9)
    a = r[db > floor]
    return 20 * np.log10(np.sqrt(np.mean(a ** 2)) + 1e-9)
def music_chain(gain_db, out):
    fc = (f"[2:a]atrim=0:{VL},asetpts=PTS-STARTPTS,highpass=f=45,equalizer=f=1500:t=q:w=1:g=-4,volume={gain_db}dB[m];"
          f"[m][0:a]sidechaincompress=threshold=0.03:ratio=2.5:attack=30:release=400[md];"
          f"[md]volume='1+0.6*clip((t-40.97)/4,0,1)':eval=frame,afade=t=in:st=0:d=0.15,afade=t=out:st={VL-0.7}:d=0.7[mo]")
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', 'a_voice.wav', '-i', 'a_sfx.wav', '-i', MUS, '-filter_complex', fc, '-map', '[mo]', '-ar', str(SR), '-ac', '1', out], check=True)
gain = -24.0
for it in range(3):
    music_chain(gain, 'a_music.wav')
    m = dec('a_music.wav'); v = dec('a_voice.wav'); n = min(len(m), len(v))
    # measure music only where the voice speaks (before the swell, t<38)
    k = int(37 * SR); win = int(0.05 * SR); idx = [i for i in range(0, k - win, win) if 20 * np.log10(np.sqrt(np.mean(v[i:i + win] ** 2)) + 1e-9) > -45]
    mm = np.sqrt(np.mean(np.concatenate([m[i:i + win] for i in idx]) ** 2)); mdb = 20 * np.log10(mm + 1e-9)
    print('iter', it, 'gain', round(gain, 1), 'music rms during speech', round(mdb, 1), 'voice', round(V, 1), 'delta', round(V - mdb, 1))
    gain += (V - 15) - mdb
    if abs((V - 15) - mdb) < 0.3: break
music_chain(gain, 'a_music.wav'); json.dump(dict(gain=float(gain)), open('music_gain.json', 'w'))
# final mix
fc = ("[0:a][1:a][2:a]amix=inputs=3:normalize=0:duration=longest,"
      f"apad=whole_dur={VL},atrim=0:{VL},acompressor=threshold=0.05:ratio=3:attack=5:release=150:makeup=2,alimiter=limit=0.2:attack=3:release=60:level=disabled[pre]")
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', 'a_voice.wav', '-i', 'a_sfx.wav', '-i', 'a_music.wav', '-filter_complex', fc, '-map', '[pre]', '-ar', str(SR), '-c:a', 'pcm_f32le', 'a_pre.wav'], check=True)
# two-pass loudnorm
r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', 'a_pre.wav', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
j = json.loads(r[r.rindex('{'):]); print('pass1', j)
ln = (f"loudnorm=I=-14:TP=-1:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true:print_format=json")
r2 = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-y', '-i', 'a_pre.wav', '-af', ln, '-ar', '48000', '-ac', '2', 'a_final.wav'], capture_output=True, text=True).stderr
j2 = json.loads(r2[r2.rindex('{'):]); print('pass2', j2)
