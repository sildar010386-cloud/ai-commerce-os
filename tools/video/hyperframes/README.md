# HyperFrames (HeyGen, open source, Apache 2.0) — captions and on-screen text

Free local renderer: an HTML page with timed clips + GSAP animation -> MP4. Used for kinetic captions
(word by word, keywords in colour, a different style per reel — owner rule 2026-10-09) and animated hooks.
No HeyGen account or credits: everything renders locally. Owner approved connecting it 2026-10-09.

Setup in the cloud session (first test 2026-10-09, v0.8.143, 6 s 1080x1920 in ~22 s):
```
export HYPERFRAMES_BROWSER_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell
npx -y hyperframes@0.8.143 telemetry disable
HYPERFRAMES_SKIP_SKILLS=1 npx -y hyperframes@0.8.143 init NAME --example blank --resolution portrait --non-interactive
cd NAME && npx -y hyperframes@0.8.143 render -o out.mp4
```
- `cdn.jsdelivr.net` is blocked by the egress proxy: GSAP must be local
  (`npm pack gsap@3.14.2`, copy `package/dist/gsap.min.js` next to `index.html`, `<script src="gsap.min.js">`).
- Source clips: convert MOV to H.264 MP4 1080x1920 first (ffmpeg), reference them with `<video class="clip" data-start data-duration>`.
- Fonts: Liberation Sans / DejaVu Sans (Cyrillic). Voice and music are mixed afterwards by `tools/video/build.py` / `tools/music/mix.py`.
- `example_captions.html` — first test: animated hook plate + word-by-word captions with coloured keywords.
