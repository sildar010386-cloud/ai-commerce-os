"""Evening report to the owner's bot (owner rule: 22:00 Almaty), without Claude.

  python3 tools/stats/evening.py            send once per day (marker content/stats/evening-<date>.sent)
  python3 tools/stats/evening.py --print    only print the report

Today: every queue slot with its status and, for Threads posts, views/likes/replies/reposts (straight from the
Threads API, nothing invented). Tomorrow: the schedule with approval status. Warns when the queue runs out
within 2 days so the owner knows the next weekly package is due.
Runs from .github/workflows/evening.yml (GitHub schedule around 22:00 Almaty).
"""
import datetime, json, os, subprocess, sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from morning import insights, queue, KIND, ROOT  # noqa: E402

ALMATY = ZoneInfo("Asia/Almaty")


def report(today):
    day = datetime.date.fromisoformat(today)
    d = lambda x: x.strftime("%d.%m")
    lines = [f"🌙 Вечерний отчёт, {d(day)}", ""]
    total, best = 0, None
    items = queue(today)
    if not items:
        lines.append("Сегодня публикаций не было (очереди нет).")
    for it in items:
        head = f"{it['time']} {it['code']} · {it.get('type', '')}"
        if not it.get("done"):
            lines.append(f"{head} — ❌ не вышел")
            continue
        if it["kind"] != "thread":
            lines.append(f"{head} — карусель отправлена в бот")
            continue
        pub = os.path.join(ROOT, "content", "threads", it["code"], "published.json")
        st = insights(json.load(open(pub))["ids"][0]) if os.path.exists(pub) else None
        if not st:
            lines.append(f"{head} — вышел, статистика недоступна")
            continue
        v = st.get("views", 0)
        total += v
        if not best or v > best[1]:
            best = (it.get("title", it["code"]), v)
        lines.append(f"{head} — 👁 {v} · ❤️ {st.get('likes', 0)} · 💬 {st.get('replies', 0)} · 🔁 {st.get('reposts', 0)}")
    if best:
        lines += ["", f"Всего просмотров Threads за день: {total}. Лучший пост: «{best[0]}» ({best[1]})."]
    tomorrow = day + datetime.timedelta(days=1)
    lines += ["", f"Завтра, {d(tomorrow)}:"]
    nxt = queue(tomorrow.isoformat())
    if not nxt:
        lines.append("⚠️ Очереди на завтра нет — публикаций не будет. Нужен пакет на неделю.")
    for it in nxt:
        mark = "по графику" if it.get("approved") else "⚠️ не одобрен — не выйдет"
        lines.append(f"{it['time']} {KIND.get(it['kind'], it['kind'])} · {it.get('title', it['code'])} — {mark}")
    left = [day + datetime.timedelta(days=i) for i in range(1, 4)]
    last = max((x for x in left if queue(x.isoformat())), default=None)
    if nxt and (last is None or last < day + datetime.timedelta(days=3)):
        lines += ["", f"📦 Очередь заканчивается {d(last or tomorrow)}. Пора собирать пакет на следующую неделю."]
    return "\n".join(lines)


def main(args):
    # the report is about the evening's day: a late run after midnight (GitHub delays, 2026-10-31 ran at 01:25)
    # still reports the day that just ended and plans the day that has just started
    today = (datetime.datetime.now(ALMATY) - datetime.timedelta(hours=6)).strftime("%Y-%m-%d")
    text = report(today)
    print(text)
    if "--print" in args:
        return
    marker = os.path.join(ROOT, "content", "stats", f"evening-{today}.sent")
    subprocess.run(["git", "pull", "-q", "--rebase"], cwd=ROOT)
    if os.path.exists(marker):
        print("already sent today")
        return
    if subprocess.run([sys.executable, os.path.join(ROOT, "tools", "telegram", "tg.py"), "send", text]).returncode:
        sys.exit("telegram send failed")
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    open(marker, "w").write(datetime.datetime.now(ALMATY).isoformat() + "\n")
    subprocess.run(["git", "add", marker], cwd=ROOT)
    subprocess.run(["git", "commit", "-q", "-m", f"Evening report {today} sent"], cwd=ROOT)
    for _ in range(3):
        subprocess.run(["git", "pull", "-q", "--rebase"], cwd=ROOT)
        if subprocess.run(["git", "push", "-q", "origin", "HEAD"], cwd=ROOT).returncode == 0:
            break


if __name__ == "__main__":
    main(sys.argv[1:])
