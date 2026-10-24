"""Send one day's content package (content/queue/<date>.json) to the owner's bot for approval.

  python3 tools/telegram/send_package.py 2026-10-25 [2026-10-26 ...]

Threads post: its picture with the full text (and our reply under selling posts) as the caption.
Carousel: the caption line, then the slides as an album. Nothing is published.
"""
import datetime, glob, json, os, re, subprocess, sys, time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
TG = [sys.executable, os.path.join(ROOT, "tools", "telegram", "tg.py")]
DAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]


def tg(*args):
    subprocess.run([*TG, *args], check=True)
    time.sleep(1.2)  # Telegram allows about one message a second per chat


def section(readme, title):
    m = re.search(rf"^## {title}.*?\n(.*?)(?=\n## |\Z)", readme, re.S | re.M)
    return m.group(1).strip() if m else ""


def send_day(date):
    d = datetime.date.fromisoformat(date)
    items = json.load(open(os.path.join(ROOT, "content", "queue", f"{date}.json")))
    tg("send", f"📅 {d.strftime('%d.%m')}, {DAYS[d.weekday()]} — {len(items)} публикаций")
    for it in items:
        head = f"{it['time']} · {it.get('type', '')} · {it['code']}"
        if it["kind"] == "thread":
            folder = os.path.join(ROOT, "content", "threads", it["code"])
            readme = open(os.path.join(folder, "README.md")).read()
            post = section(readme, "Пост 1")
            reply = section(readme, "Ответ под постом")
            text = f"{head} · Threads\n\n{post}" + (f"\n\nНаш ответ под постом: {reply}" if reply else "")
            img = os.path.join(folder, "1.jpg")
            if os.path.exists(img) and len(text) <= 1024:
                tg("photo", img, text)
            else:
                if os.path.exists(img):
                    tg("photo", img, head)
                tg("send", text + ("" if os.path.exists(img) else "\n\n(картинка будет готова завтра утром)"))
        else:
            slides = sorted(glob.glob(os.path.join(ROOT, "content", "carousels", it["code"], "0[1-9].jpg")))
            tg("send", f"{head} · TikTok карусель «{it.get('title', '')}»\nПодпись: {it.get('caption', '')}")
            if len(slides) >= 2:
                tg("photos", *slides[:10])


if __name__ == "__main__":
    for date in sys.argv[1:]:
        send_day(date)
