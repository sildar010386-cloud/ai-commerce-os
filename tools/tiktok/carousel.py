"""Render a Threads draft (content/threads/<code>/README.md) as bright TikTok carousel slides (max 10).

  python3 tools/tiktok/carousel.py T-52        -> content/threads/T-52/carousel/01.jpg ...

Owner rules: bright, pleasant slides, never dark and gloomy (2026-10-12, old dark design scored 3/10);
at most 10 slides (2026-10-14: viral home carousels have 5-14 slides; the 3-slide cap of 2026-10-12 is lifted); the first slide is intrigue (2026-10-01); the last slide always carries a
call to action (2026-10-12: "people do not know what to do next").

README lines used:
  Обложка TikTok: <headline>        cover headline; *word* is highlighted in orange
  Тег TikTok: <text>                optional pill on the cover
  CTA TikTok: <text>                CTA box on the last slide (default: write «ПАР» in comments)
  ## Слайд TikTok N — `img.jpg`     optional custom slide text instead of the posts (N = 2, 3)
Slides: cover (photo of the first post + headline) followed by the posts (or custom slides), cut to 3.
Inside a slide: the first paragraph is the headline; lines "1. ..." become numbered cards (a leading
«quote». becomes the card title; "Миф:" / "Правда:" become badges); a paragraph with «ПАР» is a CTA box.
Rendered with headless Chromium (Playwright build in /opt/pw-browsers), Montserrat (OFL) from fonts/.
"""
import glob, html, os, re, subprocess, sys, tempfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "content", "threads")
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
BROWSER = (glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell") or ["chromium"])[0]
CTA = "Напишите «ПАР» в комментариях — ответим в личные сообщения"
MAX_SLIDES = 10

CSS = """
@font-face{font-family:M;src:url(F/montserrat-cyrillic-400-normal.woff2);font-weight:400}
@font-face{font-family:M;src:url(F/montserrat-cyrillic-600-normal.woff2);font-weight:600}
@font-face{font-family:M;src:url(F/montserrat-cyrillic-800-normal.woff2);font-weight:800}
@font-face{font-family:M;src:url(F/montserrat-cyrillic-900-normal.woff2);font-weight:900}
@font-face{font-family:M;src:url(F/montserrat-latin-400-normal.woff2);font-weight:400;unicode-range:U+0000-00FF}
@font-face{font-family:M;src:url(F/montserrat-latin-600-normal.woff2);font-weight:600;unicode-range:U+0000-00FF}
@font-face{font-family:M;src:url(F/montserrat-latin-800-normal.woff2);font-weight:800;unicode-range:U+0000-00FF}
@font-face{font-family:M;src:url(F/montserrat-latin-900-normal.woff2);font-weight:900;unicode-range:U+0000-00FF}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden}
body{font-family:M,sans-serif;background:#F7F1E8;color:#1E1B18;position:relative;font-size:var(--s,40px)}
.tag{display:inline-block;background:#1E1B18;color:#F7F1E8;font-weight:800;font-size:34px;padding:16px 30px;border-radius:999px}
.brand{position:absolute;bottom:64px;left:80px;font-weight:600;font-size:30px;color:#8A7F73}
.swipe{position:absolute;bottom:56px;right:80px;font-weight:800;font-size:34px;color:#F26B1E}
.mark{background:#F26B1E;color:#fff;padding:0 18px;border-radius:18px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.photo{position:absolute;top:0;left:0;width:1080px;height:1250px;background-size:cover;background-position:center 60%}
.fade{position:absolute;top:900px;left:0;width:1080px;height:360px;background:linear-gradient(rgba(247,241,232,0),#F7F1E8)}
.top{position:absolute;top:80px;left:80px;right:80px}
h1{position:absolute;top:1170px;left:80px;right:80px;font-weight:900;font-size:100px;line-height:1.1;letter-spacing:-1px}
#wrap{position:absolute;top:0;bottom:150px;left:80px;right:80px;display:flex;flex-direction:column;justify-content:center}
.pic{height:620px;border-radius:40px;background-size:cover;background-position:center;margin-bottom:44px;flex:none}
h2{font-weight:900;font-size:1.75em;line-height:1.15;margin-bottom:.6em}
p{font-weight:600;font-size:1em;line-height:1.4;color:#4A423A;margin-bottom:.7em}
p.ask{font-weight:900;font-size:1.2em;color:#F26B1E;line-height:1.25}
.card{background:#fff;border-radius:36px;padding:.9em 1.05em;margin-bottom:.7em;display:flex;align-items:flex-start;box-shadow:0 10px 30px rgba(60,40,20,.08)}
.num{flex:none;width:2.2em;height:2.2em;border-radius:50%;background:#F7F1E8;color:#F26B1E;font-weight:900;font-size:1.15em;display:flex;align-items:center;justify-content:center;margin-right:.75em}
.card b{display:block;font-weight:800;font-size:1.05em;line-height:1.25;margin-bottom:.25em}
.card span{font-weight:400;font-size:.92em;line-height:1.38;color:#4A423A}
.badge{display:inline-block;font-weight:900;font-size:.72em;padding:.3em .75em;border-radius:999px;margin-bottom:.45em;letter-spacing:1px}
.myth{background:#FFE3E0;color:#D64532}.truth{background:#DDF5E6;color:#1E9E55}
.deco1{position:absolute;top:-260px;right:-260px;width:820px;height:820px;border-radius:50%;background:#F26B1E;opacity:.92}
.deco2{position:absolute;bottom:-200px;left:-160px;width:560px;height:560px;border-radius:50%;background:#FFD9BF}
h1.big{top:560px;font-size:124px}
.cta{background:#F26B1E;color:#fff;border-radius:36px;padding:.9em 1.1em;font-weight:800;font-size:1.05em;line-height:1.3;margin-top:.5em}
"""

FIT = """<script>
document.fonts.ready.then(()=>{const w=document.getElementById('inner');if(!w)return;
let s=52;const lim=1920-150-160;
while(s>28){document.body.style.setProperty('--s',s+'px');if(w.offsetHeight<=lim)break;s-=2;}});
</script>"""


def page(body):
    css = CSS.replace("url(F/", f"url(file://{FONTS}/")
    return f'<html><head><meta charset="utf-8"><style>{css}</style></head><body>{body}{FIT}</body></html>'


def esc(t):
    return html.escape(t).replace("\n", "<br>")


def highlight(t):
    return re.sub(r"\*(.+?)\*", r'<span class="mark">\1</span>', esc(t))


def card(n, text):
    m = re.match(r"(«[^»]+»\.?)\s*(.*)", text)
    title, rest = (m.group(1).rstrip("."), m.group(2)) if m else ("", text)
    badge = ""
    b = re.match(r"(Миф|Правда)[:.]\s*(.*)", rest)
    if b:
        kind = "myth" if b.group(1) == "Миф" else "truth"
        badge, rest = f'<div class="badge {kind}">{b.group(1).upper()}</div>', b.group(2)
        rest = rest[:1].upper() + rest[1:]
    inner = f"{badge}<b>{esc(title)}</b><span>{esc(rest)}</span>" if title else f"<b>{esc(rest)}</b>"
    return f'<div class="card"><div class="num">{n}</div><div>{inner}</div></div>'


def text_slide(text, image, last, cta):
    text = text.rstrip().rstrip("↓").rstrip()
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    out = [f'<div class="pic" style="background-image:url(file://{image})"></div>'] if image else []
    has_cta = False
    for k, para in enumerate(paras):
        m = re.match(r"(\d+)\.\s+(.*)", para)
        if m:
            out.append(card(m.group(1), m.group(2)))
        elif "«ПАР»" in para:
            out.append(f'<div class="cta">{esc(para)}</div>'); has_cta = True
        elif k == 0:
            out.append(f"<h2>{esc(para)}</h2>")
        elif para.endswith("?"):
            out.append(f'<p class="ask">{esc(para)}</p>')
        else:
            out.append(f"<p>{esc(para)}</p>")
    if last and not has_cta:
        out.append(f'<div class="cta">{esc(cta)}</div>')
    foot = '<div class="brand">@bikas.home</div>' + ("" if last else '<div class="swipe">листай →</div>')
    return page(f'<div id="wrap"><div id="inner">{"".join(out)}</div></div>{foot}')


def cover_slide(headline, image, tag):
    photo = (f'<div class="photo" style="background-image:url(file://{image})"></div><div class="fade"></div>'
             if image else "")
    top = f'<div class="top"><span class="tag">{esc(tag)}</span></div>' if tag else ""
    h_cls = "" if image else ' class="big"'
    deco = "" if image else '<div class="deco1"></div><div class="deco2"></div>'
    return page(f'{deco}{photo}{top}<h1{h_cls}>{highlight(headline)}</h1>'
                '<div class="brand">@bikas.home</div><div class="swipe">листай →</div>')


def render(doc, out):
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(doc)
    png = out[:-4] + ".png"
    subprocess.run([BROWSER, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                    "--allow-file-access-from-files", "--window-size=1080,1920", "--virtual-time-budget=4000",
                    f"--screenshot={png}", f"file://{f.name}"], capture_output=True, check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", png, "-q:v", "2", out], check=True)
    os.remove(png); os.remove(f.name)


def sections(readme, head):
    return [(re.findall(r"`([^`]+\.jpg)`", m.group(1)), m.group(2).strip())
            for m in re.finditer(rf"^## {head} \d+(.*?)\n(.*?)(?=\n## |\Z)", readme, re.S | re.M)]


def main(code):
    folder = os.path.abspath(os.path.join(ROOT, code))
    readme = open(os.path.join(folder, "README.md")).read()
    line = lambda key: (re.search(rf"^{key}: (.+)$", readme, re.M) or [None, None])[1]
    posts = sections(readme, "Пост")
    custom = sections(readme, "Слайд TikTok")
    slides = custom or posts
    first_img = next((os.path.join(folder, i[0]) for i, _ in posts if i), None)
    cta = line("CTA TikTok")
    cta = CTA if not cta or cta.strip() == "-" else cta.strip()
    out = os.path.join(folder, "carousel")
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(out):
        os.remove(os.path.join(out, name))
    docs = []
    if line("Обложка TikTok"):
        docs.append(cover_slide(line("Обложка TikTok").strip(), first_img, (line("Тег TikTok") or "").strip()))
    body = slides[:MAX_SLIDES - len(docs)]
    for k, (imgs, text) in enumerate(body):
        img = os.path.join(folder, imgs[0]) if imgs and custom else None  # photos only on custom slides
        docs.append(text_slide(text, img, k == len(body) - 1, cta))
    for i, d in enumerate(docs, 1):
        path = os.path.join(out, f"{i:02d}.jpg")
        render(d, path)
        print(path)


if __name__ == "__main__":
    main(sys.argv[1])
