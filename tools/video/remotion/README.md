# Remotion motion-graphics reels (test 2026-10-15)

Owner request 2026-10-15: try Remotion (React → video, official Agent Skills `remotion-dev/skills`) next to HyperFrames.
Live footage stays underneath; Remotion draws the animated layer (hook sticker, cross-outs, timer ring, crease line
that straightens, checklist, typing «ПАР» bubble, punch-in and light flash on every cut, word captions).

```
cd /home/user/work/remotion            # work copy: npm i (see package.json), src/ from here
cp /home/user/work/clean_R42.mp4 public/clean.mp4
# public/data.json: {"offset", "chunks" (build.chunks(build.words_of(NAME))), "cuts", "total", "keywords"}
npx remotion render src/index.ts Reel out.mp4 --muted \
  --browser-executable=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell --concurrency=4
```
Then mux the voice from `out/<reel>.mp4` and run `tools/music/mix.py`, as in the HyperFrames pipeline.
License: Remotion is free for individuals and companies of up to 3 people (remotion.dev/license).
