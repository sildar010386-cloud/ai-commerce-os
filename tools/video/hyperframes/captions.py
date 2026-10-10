"""Write a HyperFrames composition with kinetic captions over a clean (text-free) reel.

  python3 tools/video/hyperframes/captions.py SPEC_JSON NAME CLEAN_MP4 OUT_DIR

SPEC_JSON is a raw-NN specs file (tools/video/build.py format) plus an optional "keywords" map
{word_without_punctuation_lowercase: colour_class}. Word timings come from the ElevenLabs JSON next to the
voice mp3 (run from the work dir, like build.py). Each word pops in at the moment it is spoken; keywords
get their colour and a short scale punch (owner rule 2026-10-09: key words in different colours, captions
that catch the eye). Hook/Cta texts from "texts" become animated plates at the top.
Render: see README.md; the audio is muxed afterwards from the reel built by build.py.
"""
import html, json, os, re, shutil, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import build  # noqa: E402  (words_of, chunks)

CSS = """*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden;background:#000}
#root{position:relative;width:100%;height:100%;font-family:"Liberation Sans","DejaVu Sans",sans-serif}
#bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cap{position:absolute;left:50px;right:50px;top:1230px;text-align:center;font-weight:800;font-size:90px;line-height:1.12;
 color:#fff;text-shadow:0 5px 0 #000,0 0 16px rgba(0,0,0,.85),3px 0 0 #000,-3px 0 0 #000}
.cap span{display:inline-block;margin:0 9px;opacity:0}
.y{color:#FFD60A}.o{color:#FF7A1A}.g{color:#3DDC84}.r{color:#FF4D4D}
.plate{position:absolute;top:250px;left:60px;right:60px;text-align:center;font-weight:800;font-size:76px;line-height:1.15;
 padding:26px 24px;border-radius:26px;opacity:0}
.Hook{background:#FFD60A;color:#111}.Cta{background:#FF7A1A;color:#fff}.Label{background:#fff;color:#111}
"""


def main(spec_path, name, clean, out):
    spec = json.load(open(spec_path))[name]
    keys = spec.get("keywords", {})
    os.makedirs(out, exist_ok=True)
    shutil.copy(clean, os.path.join(out, "clean.mp4"))
    total = sum(s["dur"] for s in spec["segments"])
    body, js = [], []
    for k, (text, t0, t1, style) in enumerate(spec.get("texts", [])):
        if style not in ("Hook", "Cta", "Label"):
            continue
        t1 = min(t1, total)
        body.append(f'<div id="p{k}" class="plate {style} clip" data-start="{t0}" data-duration="{t1 - t0:.2f}" '
                    f'data-track-index="{1 + k}">{html.escape(text)}</div>')
        js.append(f'tl.fromTo("#p{k}",{{opacity:0,scale:0.5}},{{opacity:1,scale:1,duration:0.3,ease:"back.out(2.2)"}},{t0});')
        js.append(f'tl.to("#p{k}",{{rotation:-2,duration:0.12,yoyo:true,repeat:3}},{t0 + 0.35});')
        js.append(f'tl.to("#p{k}",{{opacity:0,y:-50,duration:0.2}},{max(t0, t1 - 0.2)});')
    track = 20
    for part, start in spec.get("voice", []):
        cs = build.chunks(build.words_of(part))
        for j, c in enumerate(cs):
            t0 = start + c[0][1]
            t1 = start + (cs[j + 1][0][1] if j + 1 < len(cs) else min(c[-1][2] + 0.5, total - start))
            spans = []
            for i, (w, ws, _) in enumerate(c):
                cls = keys.get(re.sub(r"[^\w]", "", w.lower()), "")
                spans.append(f'<span id="w{track}_{i}" class="{cls}">{html.escape(w)}</span>')
                js.append(f'tl.fromTo("#w{track}_{i}",{{opacity:0,y:36,scale:0.55}},'
                          f'{{opacity:1,y:0,scale:1,duration:0.16,ease:"back.out(3)"}},{start + ws:.2f});')
                if cls:
                    js.append(f'tl.to("#w{track}_{i}",{{scale:1.18,duration:0.12,yoyo:true,repeat:1}},{start + ws + 0.16:.2f});')
            body.append(f'<div class="cap clip" data-start="{t0:.2f}" data-duration="{t1 - t0:.2f}" '
                        f'data-track-index="{track}">{"".join(spans)}</div>')
            track += 1
    page = f"""<!doctype html>
<html lang="ru" data-resolution="portrait"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<script src="gsap.min.js"></script><style>{CSS}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{total:.2f}" data-width="1080" data-height="1920">
<video id="bg" class="clip" src="clean.mp4" muted playsinline data-start="0" data-duration="{total:.2f}" data-track-index="0"></video>
{chr(10).join(body)}
</div>
<script>
const tl = gsap.timeline({{ paused: true }});
{chr(10).join(js)}
window.__timelines["main"] = tl;
tl.seek(0);
</script></body></html>
"""
    open(os.path.join(out, "index.html"), "w").write(page)
    print(os.path.join(out, "index.html"), f"{total:.1f}s")


if __name__ == "__main__":
    main(*sys.argv[1:5])
