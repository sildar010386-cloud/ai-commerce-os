"""Mix a background track under a finished voiced video (settings from content/music/README.md).

  python3 tools/music/mix.py VIDEO.mp4 TRACK.mp3 OUT.mp4 [START_SEC]

Track -> loudnorm -20 LUFS, fade in 0.3 s / out 2 s, EQ -4 dB at 1.5 kHz, highpass 45 Hz, volume 0.65,
ducked under the voice (sidechaincompress threshold 0.06, ratio 2.5, attack 30, release 400).
The video stream is copied; the mono voice is copied to both channels at its rendered level.
"""
import subprocess, sys

video, track, out = sys.argv[1:4]
start = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                           capture_output=True, text=True, check=True).stdout)
fc = (f"[1:a]atrim=start={start}:duration={dur},asetpts=PTS-STARTPTS,loudnorm=I=-20:TP=-2,"
      f"afade=t=in:d=0.3,afade=t=out:st={dur - 2:.2f}:d=2,equalizer=f=1500:t=o:w=1:g=-4,highpass=f=45,"
      f"volume=0.65,aresample=44100[m];"
      f"[0:a]aresample=44100,pan=stereo|c0=c0|c1=c0,asplit[v][sc];[m][sc]sidechaincompress=threshold=0.06:ratio=2.5:attack=30:release=400[mc];"
      f"[v][mc]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95:level=disabled[a]")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-i", track, "-filter_complex", fc,
                "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
                "-movflags", "+faststart", out], check=True)
print(out)
