"""Morning report to the owner's bot (owner rule: 09:00 Almaty), without Claude.

  python3 tools/stats/morning.py            send once per day (marker content/stats/morning-<date>.sent)
  python3 tools/stats/morning.py --print    only print the report

Yesterday: every queue slot with its status and, for Threads posts, views/likes/replies/reposts.
Today: the schedule with approval status. Numbers come straight from the Threads API, no conclusions are invented.
Runs from .github/workflows/morning.yml (started at 09:00 by the CRM's Cloudflare cron, GitHub schedule as backup).
"""
import datetime, json, os, subprocess, sys, urllib.parse, urllib.request
from zoneinfo import ZoneInfo

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
ALMATY = ZoneInfo("Asia/Almaty")
KIND = {"thread": "Threads", "carousel": "TikTok карусель"}


def insights(post_id):
    q = urllib.parse.urlencode({"metric": "views,likes,replies,reposts", "access_token": os.environ["THREADS_ACCESS_TOKEN"]})
    try:
        data = json.load(urllib.request.urlopen(f"https://graph.threads.net/v1.0/{post_id}/insights?{q}", timeout=30))
    except Exception as e:  # one broken post must not stop the report
        print(f"insights {post_id}: {type(e).__name__}")
        return None
    return {d["name"]: d["values"][0]["value"] for d in data.get("data", [])}


def queue(date):
    p = os.path.join(ROOT, "content", "queue", f"{date}.json")
    return json.load(open(p)) if os.path.exists(p) else []


def report(today):
    yesterday = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()
    d = lambda s: datetime.date.fromisoformat(s).strftime("%d.%m")
    lines = [f"☀️ Утренний отчёт, {d(today)}", "", f"Вчера, {d(yesterday)}:"]
    total, with_photo, without = 0, [], []
    for it in queue(yesterday):
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
        readme = open(os.path.join(ROOT, "content", "threads", it["code"], "README.md")).read()
        photo = "## Пост 1 — без картинки" not in readme
        (with_photo if photo else without).append(st.get("views", 0))
        total += st.get("views", 0)
        lines.append(f"{head}{' · фото' if photo else ''} — 👁 {st.get('views', 0)} · ❤️ {st.get('likes', 0)}"
                     f" · 💬 {st.get('replies', 0)} · 🔁 {st.get('reposts', 0)}")
    if with_photo or without:
        avg = lambda xs: round(sum(xs) / len(xs)) if xs else 0
        lines += ["", f"Всего просмотров Threads: {total}. В среднем: с фото {avg(with_photo)}, без фото {avg(without)}."]
    lines += ["", f"Сегодня, {d(today)}:"]
    items = queue(today)
    if not items:
        lines.append("⚠️ Очереди на сегодня нет — публикаций не будет.")
    for it in items:
        mark = "✅ вышел" if it.get("done") else ("по графику" if it.get("approved") else "⚠️ не одобрен — не выйдет")
        lines.append(f"{it['time']} {KIND.get(it['kind'], it['kind'])} · {it.get('title', it['code'])} — {mark}")
    return "\n".join(lines)


def main(args):
    today = datetime.datetime.now(ALMATY).strftime("%Y-%m-%d")
    text = report(today)
    print(text)
    if "--print" in args:
        return
    marker = os.path.join(ROOT, "content", "stats", f"morning-{today}.sent")
    subprocess.run(["git", "pull", "-q", "--rebase"], cwd=ROOT)
    if os.path.exists(marker):
        print("already sent today")
        return
    if subprocess.run([sys.executable, os.path.join(ROOT, "tools", "telegram", "tg.py"), "send", text]).returncode:
        sys.exit("telegram send failed")
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    open(marker, "w").write(datetime.datetime.now(ALMATY).isoformat() + "\n")
    subprocess.run(["git", "add", marker], cwd=ROOT)
    subprocess.run(["git", "commit", "-q", "-m", f"Morning report {today} sent"], cwd=ROOT)
    for _ in range(3):
        subprocess.run(["git", "pull", "-q", "--rebase"], cwd=ROOT)
        if subprocess.run(["git", "push", "-q", "origin", "HEAD"], cwd=ROOT).returncode == 0:
            break


if __name__ == "__main__":
    main(sys.argv[1:])
