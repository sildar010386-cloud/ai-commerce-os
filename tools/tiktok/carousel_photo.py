"""Render bright "marketplace card" TikTok carousel slides (photo on top, bold text panel below) from a JSON file.

  python3 tools/tiktok/carousel_photo.py content/carousels/proba-1/slides.json   -> 01.jpg ... + contact.jpg next to the JSON

Owner rule 2026-10-22: slides must be bright, juicy, high contrast like Wildberries/Ozon infographic cards;
big bold type (title >= 80 px, text >= 46 px); one style per carousel, one accent colour per carousel.
Separate from carousel.py (that one renders Threads drafts); here the text comes verbatim from the JSON.

JSON: {"accent": "#FFD60A", "dark": "#1B1B1B", "brand": "@bikas.home", "slides": [...]}
Slide types ("kind"):
  cover   title (big question) + text (small line) + photo
  photo   title + text + photo (if the file is missing, "emoji" is shown instead)
  list    title + items [{"icon": "🫖", "text": "Label: value"}]   (cheat sheet, no photo)
  final   text (paragraphs split by \\n; the first is the big CTA)   (no photo, save icon)
Photo paths are relative to the JSON file. Counter N/total and «листай →» are added automatically
(no swipe hint on the last slide). Rendered with headless Chromium, Montserrat (OFL) from fonts/.
"""
import glob, html, json, math, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "fonts")
BROWSER = (glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell")
           + glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")
           or ["chromium"])[0]

CSS = """
@font-face{font-family:M;src:url(F/montserrat-cyrillic-600-normal.woff2);font-weight:600}
@font-face{font-family:M;src:url(F/montserrat-cyrillic-800-normal.woff2);font-weight:800}
@font-face{font-family:M;src:url(F/montserrat-cyrillic-900-normal.woff2);font-weight:900}
@font-face{font-family:M;src:url(F/montserrat-latin-600-normal.woff2);font-weight:600;unicode-range:U+0000-00FF}
@font-face{font-family:M;src:url(F/montserrat-latin-800-normal.woff2);font-weight:800;unicode-range:U+0000-00FF}
@font-face{font-family:M;src:url(F/montserrat-latin-900-normal.woff2);font-weight:900;unicode-range:U+0000-00FF}
*{margin:0;padding:0;box-sizing:border-box}
:root{--a:ACCENT;--d:DARK;--t:96px;--b:54px}
html,body{width:1080px;height:1920px;overflow:hidden}
body{font-family:M,"Noto Color Emoji",sans-serif;background:var(--a);color:var(--d);position:relative;display:flex;flex-direction:column}
.photo{flex:1;min-height:0;position:relative;background-size:cover;background-position:center;border-radius:0 0 80px 80px;
  border-bottom:12px solid var(--d);overflow:hidden}
.photo.emoji{display:flex;align-items:center;justify-content:center;font-size:420px;
  background:radial-gradient(circle at 50% 45%,#fff 0,rgba(255,255,255,.35) 55%,rgba(255,255,255,0) 75%),var(--a)}
.panel{flex:none;padding:46px 64px 40px;display:flex;flex-direction:column}
h1{font-weight:900;font-size:var(--t);line-height:1.04;letter-spacing:-1px;margin-bottom:30px}
.box{background:#fff;border:6px solid var(--d);border-radius:44px;padding:30px 38px;box-shadow:12px 12px 0 var(--d);
  font-weight:800;font-size:var(--b);line-height:1.28}
.box.small{background:var(--d);color:#fff;font-size:calc(var(--b)*.85);box-shadow:none;border-color:var(--d)}
.foot{display:flex;justify-content:space-between;align-items:center;margin-top:38px}
.brand{font-weight:800;font-size:36px;opacity:.75}
.swipe{background:var(--d);color:var(--a);font-weight:900;font-size:46px;padding:16px 38px;border-radius:999px}
.star{position:absolute;top:44px;left:44px;width:210px;height:210px;display:flex;align-items:center;justify-content:center;
  font-weight:900;font-size:60px;z-index:5}
.star i{position:absolute;inset:0;background:var(--d);clip-path:polygon(STAR1)}
.star b{position:absolute;inset:9px;background:var(--a);clip-path:polygon(STAR1)}
.star span{position:relative;color:var(--d)}
.star.flat{position:absolute}
/* list slide */
.list{padding:60px 64px 40px;flex:1;display:flex;flex-direction:column;position:relative;z-index:2}
.list h1{font-size:104px;margin:230px 0 40px}
.rows{flex:1;display:flex;flex-direction:column;gap:28px;justify-content:center}
.row{background:#fff;border:6px solid var(--d);border-radius:44px;box-shadow:12px 12px 0 var(--d);padding:26px 34px;
  display:flex;align-items:center;gap:30px;flex:1;max-height:270px}
.ico{flex:none;width:150px;height:150px;border-radius:50%;background:var(--a);border:6px solid var(--d);
  display:flex;align-items:center;justify-content:center;font-size:92px}
.lab{font-weight:900;font-size:58px;line-height:1.1}
.val{font-weight:800;font-size:50px;line-height:1.2;margin-top:10px;display:inline-block;background:var(--a);padding:2px 16px;border-radius:16px;
  border:4px solid var(--d)}
.deco{position:absolute;border-radius:50%;background:#fff;opacity:.35}
/* final slide */
.final{flex:1;display:flex;flex-direction:column;padding:290px 64px 40px;position:relative;z-index:2}
.save{width:380px;height:380px;border-radius:50%;background:#fff;border:12px solid var(--d);box-shadow:16px 16px 0 var(--d);
  display:flex;align-items:center;justify-content:center;margin:0 auto 70px}
.final .box{font-size:58px;margin-bottom:34px}
.final .box.ask{background:var(--d);color:#fff}
.final .box.ask em{font-style:normal;color:var(--a)}
.final .foot{margin-top:auto}
"""

FIT = """<script>
document.fonts.ready.then(()=>{const p=document.querySelector('.photo');if(!p)return;
let t=104;const r=document.documentElement.style;
while(t>80){r.setProperty('--t',t+'px');r.setProperty('--b',Math.max(46,Math.round(t*.55))+'px');
if(p.offsetHeight>=MINPHOTO)break;t-=2;}
if(p.offsetHeight<MINPHOTO){r.setProperty('--b','46px');}});
</script>"""


def star_points(n=18, r_out=50, r_in=41):
    pts = []
    for i in range(n * 2):
        r = r_out if i % 2 == 0 else r_in
        a = math.pi * i / n - math.pi / 2
        pts.append(f"{50 + r * math.cos(a):.1f}% {50 + r * math.sin(a):.1f}%")
    return ",".join(pts)


def esc(t):
    return html.escape(t).replace("\n", "<br>")


def page(body, cfg, fit=True, min_photo=640):
    css = CSS.replace("url(F/", f"url(file://{FONTS}/").replace("ACCENT", cfg["accent"]).replace("DARK", cfg["dark"])
    css = css.replace("STAR1", star_points())
    script = FIT.replace("MINPHOTO", str(min_photo)) if fit else ""
    return f'<html><head><meta charset="utf-8"><style>{css}</style></head><body>{body}{script}</body></html>'


def counter(n, total):
    return f'<div class="star"><i></i><b></b><span>{n}/{total}</span></div>'


def footer(cfg, last):
    swipe = "" if last else '<div class="swipe">листай →</div>'
    return f'<div class="foot"><div class="brand">{esc(cfg["brand"])}</div>{swipe}</div>'


def photo_block(s, base):
    path = os.path.join(base, s["photo"]) if s.get("photo") else ""
    if path and os.path.exists(path):
        pos = s.get("pos", "center")
        return f'<div class="photo" style="background-image:url(file://{path});background-position:{pos}">'
    return f'<div class="photo emoji">{s.get("emoji", "")}'


def photo_slide(s, n, total, cfg, base, cover):
    text_cls = "box small" if cover else "box"
    text = f'<div class="{text_cls}">{esc(s["text"])}</div>' if s.get("text") else ""
    body = (f'{photo_block(s, base)}{counter(n, total)}</div>'
            f'<div class="panel"><h1>{esc(s["title"])}</h1>{text}{footer(cfg, n == total)}</div>')
    return page(body, cfg, min_photo=560 if cover else 640)


def list_slide(s, n, total, cfg):
    rows = []
    for it in s["items"]:
        label, _, value = it["text"].partition(": ")
        rows.append(f'<div class="row"><div class="ico">{it["icon"]}</div>'
                    f'<div><div class="lab">{esc(label)}</div><div class="val">{esc(value)}</div></div></div>')
    deco = '<div class="deco" style="width:700px;height:700px;top:-260px;right:-240px"></div>' \
           '<div class="deco" style="width:520px;height:520px;bottom:-200px;left:-200px"></div>'
    body = (f'{deco}{counter(n, total)}<div class="list"><h1>{esc(s["title"])}</h1>'
            f'<div class="rows">{"".join(rows)}</div>{footer(cfg, n == total)}</div>')
    return page(body, cfg, fit=False)


def final_slide(s, n, total, cfg):
    save = (f'<svg width="220" height="260" viewBox="0 0 24 28"><path d="M3 2h18v24l-9-6.5L3 26z" fill="{cfg["accent"]}" '
            f'stroke="{cfg["dark"]}" stroke-width="2.2" stroke-linejoin="round"/></svg>')
    paras = [p for p in s["text"].split("\n") if p.strip()]
    boxes = f'<div class="box">{esc(paras[0])}</div>'
    for p in paras[1:]:
        boxes += f'<div class="box ask"><em>{esc(p)}</em></div>'
    deco = '<div class="deco" style="width:800px;height:800px;top:-300px;left:-300px"></div>' \
           '<div class="deco" style="width:600px;height:600px;bottom:-220px;right:-220px"></div>'
    body = (f'{deco}{counter(n, total)}<div class="final"><div class="save">{save}</div>{boxes}'
            f'{footer(cfg, True)}</div>')
    return page(body, cfg, fit=False)


def render(doc, out):
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(doc)
    png = out[:-4] + ".png"
    subprocess.run([BROWSER, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                    "--allow-file-access-from-files", "--window-size=1080,1920", "--virtual-time-budget=4000",
                    f"--screenshot={png}", f"file://{f.name}"], capture_output=True, check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", png, "-q:v", "2", out], check=True)
    os.remove(png); os.remove(f.name)


def contact(folder, count):
    cols = 5 if count > 6 else 3
    rows = math.ceil(count / cols)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "1", "-i", os.path.join(folder, "%02d.jpg"),
                    "-vf", f"scale=300:-1,tile={cols}x{rows}:padding=12:color=white", "-frames:v", "1", "-q:v", "3",
                    os.path.join(folder, "contact.jpg")], check=True)


def main(path):
    path = os.path.abspath(path)
    base = os.path.dirname(path)
    cfg = json.load(open(path))
    cfg.setdefault("dark", "#1B1B1B"); cfg.setdefault("brand", "@bikas.home")
    slides, total = cfg["slides"], len(cfg["slides"])
    for n, s in enumerate(slides, 1):
        kind = s.get("kind", "photo")
        if kind == "list":
            doc = list_slide(s, n, total, cfg)
        elif kind == "final":
            doc = final_slide(s, n, total, cfg)
        else:
            doc = photo_slide(s, n, total, cfg, base, kind == "cover")
        out = os.path.join(base, f"{n:02d}.jpg")
        render(doc, out)
        print(out)
    contact(base, total)


if __name__ == "__main__":
    main(sys.argv[1])
