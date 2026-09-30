# Video builder

Assembles 9:16 MP4s (1080x1920, 30 fps) from raw clips of a `raw-NN` release:
ElevenLabs voice parts with timestamps, burned ASS subtitles, hook/CTA text,
optional real-time timer and before/after split.

Per release, `content/raw-NN/` holds `voice.json` (part id -> text) and
`specs.json` (segments, voice placement, on-screen texts).

```
pip install imageio-ffmpeg   # static ffmpeg with libass, if ffmpeg is missing
cd <work dir>                # raw clips in ./raw (or RAW_DIR), TTS output lands here
python3 tools/video/tts.py content/raw-NN/voice.json
SPECS=content/raw-NN/specs.json python3 tools/video/build.py [A B ...]
```

Voice settings: `content/voice/VOICE.md`. Output goes to `out/`; bitrate is capped so files stay under the 30 MB chat upload limit.
Rendered videos and raw clips are not committed.
