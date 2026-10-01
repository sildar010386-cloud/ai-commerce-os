"""Render a Threads draft (content/threads/<code>/README.md) as TikTok photo-carousel slides.

  python3 tools/tiktok/carousel.py T-03            -> content/threads/T-03/carousel/01.jpg ...

An optional line "Обложка TikTok: <5-7 words>" in the README adds a cover slide first: the intrigue
phrase in large type over the first post's photo (owner rule 2026-10-01: the first slide is intrigue, not a
retelling of the post). Each "## Пост N" becomes one 1080x1920 slide. A post with an image gets the photo as a darkened
background; text-only posts get a dark brand background. The trailing "↓" of a post turns into
"листай →". The last slide always carries the CTA (owner rule 2026-10-01: carousels go out without a
description, so the CTA lives on the slides): if the last post has no "WhatsApp", a CTA slide is appended.
Needs Pillow (pip install pillow).
"""
import os, re, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
BG = (24, 24, 27)
ACCENT = (242, 107, 30)  # steamer orange
CTA = "Доставка бесплатно по всему Казахстану.\nПишите нам в WhatsApp — номер в шапке профиля."
ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "content", "threads")


def parse(readme):
    posts = []
    for m in re.finditer(r"^## Пост \d+ — (.+?)\n(.*?)(?=\n## |\Z)", open(readme).read(), re.S | re.M):
        images = re.findall(r"`([^`]+\.jpg)`", m.group(1))
        posts.append((images[0] if images else None, m.group(2).strip()))
    return posts


def wrap(draw, text, font, width):
    """Paragraphs -> list of wrapped line lists."""
    paras = []
    for para in text.split("\n"):
        words, line, lines = para.split(), "", []
        for w in words:
            test = f"{line} {w}".strip()
            if draw.textlength(test, font=font) <= width:
                line = test
            else:
                lines.append(line)
                line = w
        lines.append(line)
        paras.append(lines)
    return paras


def background(path):
    if not path:
        return Image.new("RGB", (W, H), BG)
    im = Image.open(path).convert("RGB")
    scale = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)))
    left, top = (im.width - W) // 2, (im.height - H) // 2
    im = im.crop((left, top, left + W, top + H)).filter(ImageFilter.GaussianBlur(2))
    return Image.blend(im, Image.new("RGB", (W, H), (0, 0, 0)), 0.55)


def slide(text, image, n, total, last):
    more = text.rstrip().endswith("↓")
    text = text.rstrip().rstrip("↓").rstrip()
    im = background(image)
    d = ImageDraw.Draw(im)
    size = 84 if n == 1 else 68
    while True:
        font = ImageFont.truetype(FONT, size)
        paras = wrap(d, text, font, W - 160)
        lh, gap = int(size * 1.25), int(size * 0.6)
        height = sum(len(p) for p in paras) * lh + (len(paras) - 1) * gap
        if height < H - 640 or size <= 40:
            break
        size -= 4
    y = (H - height) // 2
    for k, para in enumerate(paras):
        for line in para:
            d.text((80, y), line, font=font, fill=ACCENT if k == 0 and n > 1 else "white")
            y += lh
        y += gap
    small = ImageFont.truetype(FONT, 44)
    d.text((80, 140), f"{n}/{total}", font=small, fill=ACCENT)
    if more and not last:
        d.text((W - 80, H - 260), "листай →", font=small, fill=ACCENT, anchor="ra")
    d.text((80, H - 260), "@bikas.home", font=small, fill=(200, 200, 200))
    return im


def cover(text, image):
    im = background(image)
    d = ImageDraw.Draw(im)
    size = 120
    while True:
        font = ImageFont.truetype(FONT, size)
        lines = wrap(d, text, font, W - 160)[0]
        if len(lines) * size * 1.2 < H / 2 or size <= 60:
            break
        size -= 6
    y = (H - len(lines) * int(size * 1.2)) // 2
    for line in lines:
        d.text((W // 2, y), line, font=font, fill="white", anchor="ma")
        y += int(size * 1.2)
    small = ImageFont.truetype(FONT, 48)
    d.text((W // 2, H - 300), "листай →", font=small, fill=ACCENT, anchor="ma")
    return im


def main(code):
    folder = os.path.join(ROOT, code)
    readme = open(os.path.join(folder, "README.md")).read()
    posts = parse(os.path.join(folder, "README.md"))
    m = re.search(r"^Обложка TikTok: (.+)$", readme, re.M)
    if m:
        posts.insert(0, ("COVER", m.group(1).strip()))
    if "WhatsApp" not in posts[-1][1]:
        posts.append((None, CTA))
    out = os.path.join(folder, "carousel")
    os.makedirs(out, exist_ok=True)
    first_image = next((img for img, _ in posts if img and img != "COVER"), None)
    for name in os.listdir(out):
        os.remove(os.path.join(out, name))
    body = [p for p in posts if p[0] != "COVER"]
    for i, (image, text) in enumerate(posts, 1):
        path = os.path.join(out, f"{i:02d}.jpg")
        if image == "COVER":
            im = cover(text, os.path.join(folder, first_image) if first_image else None)
        else:
            n = body.index((image, text)) + 1
            im = slide(text, image and os.path.join(folder, image), n, len(body), i == len(posts))
        im.save(path, quality=90)
        print(path)


if __name__ == "__main__":
    main(sys.argv[1])
