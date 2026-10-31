"""Selling Threads post card 1080x1350 (marketplace look), generalised from content/threads/selling-photos/src/card4.py.

  python3 tools/threads/selling_card.py content/threads/T-115 [content/threads/T-117 ...]   -> T-xxx/1.jpg

Reads T-xxx/card.json:
  {"bg": "bg.jpg",                          # AI background, relative to the post folder
   "frame": "content/carousels/K-02/src/p2.jpg",   # our REAL steamer frame (relative to repo root)
   "frame_pos": "50% 50%",                  # CSS background-position inside the round frame
   "frame_zoom": 150,                       # optional, background-size in % of circle width (default 150)
   "plaque": "Нагрев\n9 секунд",            # dark plaque top-right (\n = line break)
   "title": "Рубашка как\nновенькая",       # big headline (<= 4 short words)
   "box": "Гладит прямо на вешалке",        # white box line (<= 8 words)
   "accent": "#FFD60A"}                     # panel colour
No price, no marketplaces, no AI-drawn appliance: only allowed facts go into title/box/plaque.
"""
import glob, html, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FONTS = os.path.join(ROOT, "tools", "tiktok", "fonts")
BROWSER = (glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell")
           + glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")
           or ["chromium"])[0]


def esc(s):
    return html.escape(s).replace("\n", "<br>")


def fit(text, base, width, k):
    """font size so that the longest line fits `width` px (k = avg glyph width / em)."""
    n = max(len(l) for l in text.split("\n"))
    return int(min(base, width / (k * max(n, 1))))


def render(post_dir):
    post_dir = os.path.abspath(post_dir)
    c = json.load(open(os.path.join(post_dir, "card.json"), encoding="utf-8"))
    bg = os.path.join(post_dir, c["bg"])
    frame = c["frame"] if os.path.isabs(c["frame"]) else os.path.join(ROOT, c["frame"])
    for p in (bg, frame):
        if not os.path.exists(p):
            sys.exit("missing " + p)
    accent = c.get("accent", "#FFD60A")
    pos = c.get("frame_pos", "50% 50%")
    zoom = c.get("frame_zoom", 150)
    title, box, plaque = c["title"], c["box"], c["plaque"]
    h1 = fit(title, 92, 968, 0.70)
    bx = fit(box, 46, 880 * 1.9, 0.62) if "\n" not in box else 44
    pq = fit(plaque, 54, 540, 0.68)
    css = f"""
@font-face{{font-family:M;src:url(file://{FONTS}/montserrat-cyrillic-800-normal.woff2);font-weight:800}}
@font-face{{font-family:M;src:url(file://{FONTS}/montserrat-cyrillic-900-normal.woff2);font-weight:900}}
@font-face{{font-family:M;src:url(file://{FONTS}/montserrat-latin-800-normal.woff2);font-weight:800;unicode-range:U+0000-00FF}}
@font-face{{font-family:M;src:url(file://{FONTS}/montserrat-latin-900-normal.woff2);font-weight:900;unicode-range:U+0000-00FF}}
*{{margin:0;padding:0;box-sizing:border-box}}
:root{{--a:{accent};--d:#1B1B1B}}
html,body{{width:1080px;height:1350px;overflow:hidden}}
body{{font-family:M,sans-serif;color:var(--d);position:relative;background:var(--a)}}
.photo{{position:absolute;left:0;top:0;width:1080px;height:880px;background:url(file://{bg}) center/cover;border-radius:0 0 80px 80px;border-bottom:14px solid var(--d);overflow:hidden}}
.round{{position:absolute;left:36px;bottom:36px;width:430px;height:430px;border-radius:50%;border:14px solid var(--d);box-shadow:12px 12px 0 var(--d);background:url(file://{frame}) {pos}/{zoom}% auto no-repeat}}
.plaque{{position:absolute;right:-30px;top:60px;background:var(--d);color:var(--a);border:7px solid var(--d);box-shadow:12px 12px 0 var(--d);font-weight:900;text-align:center;line-height:1.05;font-size:{pq}px;padding:18px 60px 18px 34px;transform:rotate(5deg);border-radius:36px 0 0 36px}}
.panel{{position:absolute;left:0;right:0;top:912px;bottom:0;padding:0 56px}}
h1{{font-weight:900;font-size:{h1}px;line-height:1.02;letter-spacing:-1px;margin-bottom:24px}}
.box{{background:#fff;border:6px solid var(--d);border-radius:40px;padding:22px 34px;box-shadow:12px 12px 0 var(--d);font-weight:800;font-size:{bx}px;line-height:1.2}}
.brand{{position:absolute;right:56px;bottom:16px;font-weight:800;font-size:28px;opacity:.7}}
"""
    body = (f'<div class="photo"><div class="round"></div><div class="plaque">{esc(plaque)}</div></div>'
            f'<div class="panel"><h1>{esc(title)}</h1><div class="box">{esc(box)}</div></div><div class="brand">@bikas.home</div>')
    tmp = tempfile.mkdtemp()
    hp, png = os.path.join(tmp, "c.html"), os.path.join(tmp, "c.png")
    open(hp, "w", encoding="utf-8").write(f'<html><head><meta charset="utf-8"><style>{css}</style></head><body>{body}</body></html>')
    subprocess.run([BROWSER, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                    "--window-size=1080,1350", "--virtual-time-budget=4000", f"--screenshot={png}", "file://" + hp],
                   capture_output=True, check=True)
    out = os.path.join(post_dir, "1.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", png, "-q:v", "2", out], check=True)
    print(out)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for d in sys.argv[1:]:
        render(d)
