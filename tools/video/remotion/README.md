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

## 3D inserts (Mix3D.tsx, approved for use 2026-10-15)
- Cloth: `PlaneGeometry(4, 6)` displaced by curved creases; texture = crop of a smooth area of our garment from the 4K raw clip
  (`ffmpeg -ss T -i raw05/9.MOV -vf "scale=-2:2160,crop=1215:2160,crop=636:952:290:518"`), `meshStandardMaterial` roughness .95, grazing key light.
- Steam: soft radial-gradient sprites (`PUFF`), opacity ~0.2, a wave whose front moves across the visible window; creases relax behind it.
- Render: `npx remotion render src/index.ts Mix3D out.mp4 --muted --gl=swangle --concurrency=4 --browser-executable=...headless_shell`.
- Check stills of every second before sending; first-second dark corner of the cloth edge is a known nit (move the camera lower/closer).

## Trail3D (2026-10-16) — 3D first frame «один проход — гладкая дорожка»
`src/Trail3D.tsx`, 2,6 с (78 кадров): мятая белая ткань (складки — гауссовы гребни, текстура `public/cotton_tex.jpg` — высокочастотная часть фото нашей белой рубашки, raw-05 клип 5, 25,2 с), облако пара движется по диагонали, за ним складки в полосе ~0,8 опадают и ткань чуть светлеет (vertex colors). Облако — круглое распределение точек (равномерный квадрат давал видимый «квадрат»).
Рендер: `npx remotion render src/index.ts Trail3D out.mp4 --muted --gl=swangle --concurrency=4 --browser-executable=…/headless_shell` (~3 мин), затем как клип `td46.MOV` в `raw05/` для `build.py`. Используется: REEL-46.
