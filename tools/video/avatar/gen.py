"""Layered SVG cartoon portraits of the owner in 4 styles (ids: head, brows, eyes, mouth for later animation).
  python3 tools/video/avatar/gen.py OUTDIR  -> 4 SVGs + sheet.png. Drawn by hand from the owner photo (photo not stored in the repo)."""
import os, subprocess, glob, sys
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

FACE = "M300,140 C397,140 452,196 454,286 C457,362 454,424 434,474 C410,524 362,552 300,554 C238,552 190,524 166,474 C146,424 143,362 146,286 C148,196 203,140 300,140 Z"
HAIR = "M150,302 C138,180 214,128 300,128 C386,128 462,180 450,302 C442,272 434,250 418,232 C404,216 388,208 372,212 C346,204 322,201 300,202 C278,201 254,204 228,212 C212,208 196,216 182,232 C166,250 158,272 150,302 Z"
SHIRT = "M60,760 C70,690 120,650 200,628 L252,600 L348,600 L400,628 C480,650 530,690 540,760 Z"
COLL_L = "M252,598 L300,690 L232,708 L206,630 Z"
COLL_R = "M348,598 L300,690 L368,708 L394,630 Z"

def eye(cx, s, flip=1, h=1.0, iris=13, white="#fff", lid="#2a1d16", lw=4):
    w = 38*s; hh = 16*s*h
    p = f"M{cx-w},{340} C{cx-w*0.55},{340-hh*1.25} {cx+w*0.55},{340-hh*1.25} {cx+w},{338} C{cx+w*0.5},{340+hh*0.9} {cx-w*0.5},{340+hh*0.9} {cx-w},{340} Z"
    lidp = f"M{cx-w-3},{341} C{cx-w*0.55},{340-hh*1.3} {cx+w*0.55},{340-hh*1.3} {cx+w+3},{337}"
    r = iris*s
    return (f'<clipPath id="c{cx}"><path d="{p}"/></clipPath><path d="{p}" fill="{white}"/>'
            f'<g clip-path="url(#c{cx})"><circle cx="{cx+2*flip}" cy="{341}" r="{r}" fill="#4a2a1a"/>'
            f'<circle cx="{cx+2*flip}" cy="{341}" r="{r*0.5}" fill="#120a06"/>'
            f'<circle cx="{cx+2*flip+r*0.35}" cy="{341-r*0.4}" r="{r*0.28}" fill="#fff"/></g>'
            f'<path d="{lidp}" fill="none" stroke="{lid}" stroke-width="{lw}" stroke-linecap="round"/>')

def brows(fill, sk=None, sw=0):
    st = f' stroke="{sk}" stroke-width="{sw}"' if sk else ""
    l = "M200,302 C228,284 262,282 288,292 L286,306 C262,299 232,300 204,314 Z"
    r = "M400,302 C372,284 338,282 312,292 L314,306 C338,299 368,300 396,314 Z"
    return f'<g id="brows"><path d="{l}" fill="{fill}"{st}/><path d="{r}" fill="{fill}"{st}/></g>'

def pattern(col):
    lines = ""
    for i in range(-10, 20):
        x = i*48
        lines += f'<path d="M{x},600 L{x+200},800 M{x+200},600 L{x},800" stroke="{col}" stroke-width="3" stroke-dasharray="6 4"/>'
    return f'<clipPath id="sh"><path d="{SHIRT}"/></clipPath><g clip-path="url(#sh)" opacity="0.55">{lines}</g>'

def portrait(style):
    skin, skin_d, outline = "#EBC1A0", "#D29C7A", None
    defs = ""; bg = ""; extra = ""
    sw = 0; ol = ""
    if style == "3d":
        bg = '<defs><radialGradient id="bg" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#FFD9B8"/><stop offset="1" stop-color="#F26B1E"/></radialGradient>' \
             '<radialGradient id="fg" cx="45%" cy="38%" r="65%"><stop offset="0" stop-color="#F6D3B6"/><stop offset="0.7" stop-color="#E5B391"/><stop offset="1" stop-color="#C98C67"/></radialGradient>' \
             '<radialGradient id="hg" cx="50%" cy="30%" r="70%"><stop offset="0" stop-color="#4a403a"/><stop offset="1" stop-color="#1c1714"/></radialGradient>' \
             '<linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9d6dc"/></linearGradient>' \
             '<filter id="soft"><feGaussianBlur stdDeviation="6"/></filter></defs>' \
             '<rect width="600" height="760" fill="url(#bg)"/>'
        face_fill, hair_fill, shirt_fill = "url(#fg)", "url(#hg)", "url(#sg)"
        p_hair_op = 0.9
        es, eh = 1.1, 0.8
        extra_face = ('<ellipse cx="225" cy="420" rx="38" ry="22" fill="#F08F80" opacity="0.28" filter="url(#soft)"/>'
                      '<ellipse cx="375" cy="420" rx="38" ry="22" fill="#F08F80" opacity="0.28" filter="url(#soft)"/>'
                      '<ellipse cx="270" cy="200" rx="60" ry="22" fill="#fff" opacity="0.12" filter="url(#soft)"/>'
                      '<ellipse cx="300" cy="540" rx="80" ry="28" fill="#7b5a48" opacity="0.18" filter="url(#soft)"/>')
        nose = '<ellipse cx="300" cy="392" rx="14" ry="40" fill="#fff" opacity="0.13"/><path d="M262,410 C254,432 280,442 300,440 C320,442 346,432 338,410 C330,422 314,428 300,428 C286,428 270,422 262,410 Z" fill="#B97A57" opacity="0.55"/><ellipse cx="282" cy="430" rx="7" ry="4" fill="#7a4632" opacity="0.6"/><ellipse cx="318" cy="430" rx="7" ry="4" fill="#7a4632" opacity="0.6"/>'
        mouth = '<g id="mouth"><path d="M262,474 C285,480 315,480 338,474" fill="none" stroke="#8A4B3C" stroke-width="6" stroke-linecap="round"/><path d="M272,486 C290,494 310,494 328,486" fill="none" stroke="#C98C67" stroke-width="4" stroke-linecap="round" opacity="0.6"/></g>'
        stub = '<path d="M250,452 C275,440 325,440 350,452 C330,458 270,458 250,452 Z" fill="#5a4636" opacity="0.18"/>'
    elif style == "flat":
        bg = '<rect width="600" height="760" fill="#FFE8D6"/><circle cx="300" cy="360" r="270" fill="#FFC9A3"/>'
        face_fill, hair_fill, shirt_fill = "#EDBF9C", "#2E2723", "#FFFFFF"
        es, eh = 1.0, 0.75
        extra_face = '<circle cx="222" cy="420" r="22" fill="#F29C8A" opacity="0.45"/><circle cx="378" cy="420" r="22" fill="#F29C8A" opacity="0.45"/>'
        nose = '<path d="M264,420 C272,438 328,438 336,420 C326,408 274,408 264,420 Z" fill="#D69E7B"/>'
        mouth = '<g id="mouth"><path d="M266,474 C288,482 312,482 334,474" fill="none" stroke="#7E3F33" stroke-width="7" stroke-linecap="round"/></g>'
        stub = ""
    elif style == "comic":
        bg = '<defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="3.2" fill="#F26B1E" opacity="0.55"/></pattern></defs>' \
             '<rect width="600" height="760" fill="#FFD23F"/><rect width="600" height="760" fill="url(#dots)"/>'
        face_fill, hair_fill, shirt_fill = "#F0C3A0", "#1a1512", "#FFFFFF"
        sw = 7; ol = ' stroke="#111" stroke-width="7" stroke-linejoin="round"'
        es, eh = 1.0, 0.72
        extra_face = '<path d="M196,500 C236,540 364,540 404,500 C380,530 340,548 300,550 C260,548 220,530 196,500 Z" fill="#C9906E"/>'
        nose = '<path d="M268,410 C256,432 282,440 290,430 M310,430 C318,440 344,432 332,410" fill="none" stroke="#111" stroke-width="5" stroke-linecap="round"/>'
        mouth = '<g id="mouth"><path d="M260,474 C285,481 315,481 340,474" fill="none" stroke="#111" stroke-width="7" stroke-linecap="round"/><path d="M285,494 L315,494" stroke="#111" stroke-width="4" stroke-linecap="round"/></g>'
        stub = '<g fill="#111" opacity="0.5">' + "".join(f'<circle cx="{x}" cy="{y}" r="1.6"/>' for x in range(256, 346, 9) for y in (452, 460)) + "".join(f'<circle cx="{x}" cy="{y}" r="1.6"/>' for x in range(270, 332, 9) for y in (520, 530)) + '</g>'
    return dict(bg=bg, face_fill=face_fill, hair_fill=hair_fill, shirt_fill=shirt_fill, es=es, eh=eh,
                extra_face=extra_face, nose=nose, mouth=mouth, stub=stub, ol=ol)

def build(style, chibi=False):
    p = portrait("3d" if chibi else style)
    if chibi:
        p["bg"] = p["bg"].replace('stop-color="#F26B1E"', 'stop-color="#7BC8F6"').replace('stop-color="#FFD9B8"', 'stop-color="#E8F6FF"')
        p["es"], p["eh"] = 1.15, 0.95
    ol = p["ol"]
    ears = f'<ellipse cx="146" cy="356" rx="22" ry="40" fill="{p["face_fill"]}"{ol}/><ellipse cx="454" cy="356" rx="22" ry="40" fill="{p["face_fill"]}"{ol}/>'
    neck = f'<path d="M232,500 L232,606 C270,628 330,628 368,606 L368,500 Z" fill="{p["face_fill"]}"{ol}/>'
    body = (f'<path d="{SHIRT}" fill="{p["shirt_fill"]}"{ol}/>' + pattern("#c9a9b0") +
            f'<path d="M300,690 L300,760" stroke="#ddd" stroke-width="3"/><circle cx="300" cy="712" r="7" fill="#555"/><circle cx="300" cy="748" r="7" fill="#555"/>'
            f'<path d="{COLL_L}" fill="{p["shirt_fill"]}"{ol or " stroke=\"#ddd\" stroke-width=\"3\""}/><path d="{COLL_R}" fill="{p["shirt_fill"]}"{ol or " stroke=\"#ddd\" stroke-width=\"3\""}/>')
    lid = "#111" if style == "comic" else "#2a1d16"
    eyes = '<g id="eyes">' + eye(247, p["es"], 1, p["eh"], lid=lid, lw=5 if style=="comic" else 4) + eye(353, p["es"], -1, p["eh"], lid=lid, lw=5 if style=="comic" else 4) + '</g>'
    head = (f'<g id="head">{ears}<path d="{FACE}" fill="{p["face_fill"]}"{ol}/>{p["extra_face"]}{p["stub"]}'
            f'<path d="{HAIR}" fill="{p["hair_fill"]}"{ol}/>'
            + ('<g opacity="0.25">' + "".join(f'<circle cx="{x}" cy="{y}" r="1.3" fill="#fff"/>' for x, y in __import__("random").Random(7).sample([(a, b) for a in range(180, 422, 5) for b in range(140, 215, 5)], 260)) + '</g>' if style != "flat" else "")
            + brows("#1f1915" if style != "comic" else "#111") + eyes + p["nose"] + p["mouth"] + '</g>')
    if chibi:
        body_g = f'<g transform="translate(300,760) scale(0.62) translate(-300,-760)">{neck}{body}</g>'
        head_g = f'<g transform="translate(300,420) scale(1.12) translate(-300,-380)">{head}</g>'
    else:
        body_g, head_g = neck + body, head
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 760" width="600" height="760">{p["bg"]}{body_g}{head_g}</svg>'

names = {"1_3d": build("3d"), "2_flat": build("flat"), "3_comic": build("comic"), "4_chibi": build("3d", chibi=True)}
for n, s in names.items():
    open(f"{OUT}/{n}.svg", "w").write(s)
labels = {"1_3d": "1. 3D-мультяшный", "2_flat": "2. Плоский 2D", "3_comic": "3. Комикс", "4_chibi": "4. Большая голова"}
cells = "".join(f'<div class=c><img src="{n}.svg"><p>{labels[n]}</p></div>' for n in names)
F = "/home/user/ai-commerce-os/tools/tiktok/fonts"
open(f"{OUT}/sheet.html", "w").write(f"""<!doctype html><html><head><meta charset=utf-8><style>
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-800-normal.woff2);unicode-range:U+0400-04FF}}@font-face{{font-family:M;src:url(file://{F}/montserrat-latin-800-normal.woff2);unicode-range:U+0000-00FF}}
body{{margin:0;background:#fff;font-family:M;display:flex;gap:24px;padding:24px;width:2568px}}
.c img{{width:600px;height:760px;border-radius:24px;display:block}} p{{font-family:M,Montserrat,DejaVu Sans,sans-serif;font-size:34px;text-align:center;margin:12px 0 0}}</style></head><body>{cells}</body></html>""")
chrome = glob.glob("/opt/pw-browsers/chromium*/chrome-linux64/chrome")[0]
subprocess.run([chrome, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=2616,880",
                f"--screenshot={OUT}/sheet.png", f"file://{OUT}/sheet.html"], check=True, capture_output=True)
print("ok")
