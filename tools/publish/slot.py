"""Publish owner-approved queue slots (content/queue/<date>.json).

  python3 tools/publish/slot.py 2026-10-23 09:30   one slot (manual run)
  python3 tools/publish/slot.py --due              every approved, not yet done slot of today (Asia/Almaty)
                                                   whose time has come - what the GitHub Actions schedule runs

thread:    job.py thread (Threads post -> bot notice -> queue done -> commit), then our reply under the post
           if the item has "reply" (selling posts: «ПАР» goes only in our reply, owner 2026-10-12).
carousel:  slides content/carousels/<code>/0*.jpg + caption to the bot for a manual TikTok upload, queue done.
Never publishes a slot that is not approved or already done; a thread whose text is already on the profile
today is marked done instead of being posted again (a lost push must not cause a duplicate, docs/PUBLISHING.md).
"""
import datetime, glob, json, os, re, subprocess, sys, urllib.parse, urllib.request
from zoneinfo import ZoneInfo

ALMATY = ZoneInfo("Asia/Almaty")


def sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout + r.stderr, end="", flush=True)
    return r


def sync_push(msg):
    sh("git", "add", "-A")
    if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode:
        sh("git", "commit", "-q", "-m", msg)
    for _ in range(3):  # another writer may have pushed meanwhile: rebase and retry
        sh("git", "pull", "-q", "--rebase")
        if sh("git", "push", "-q", "origin", "HEAD").returncode == 0:
            return True
    sh(sys.executable, "tools/telegram/tg.py", "send", f"⚠️ Публикация прошла, но запись в проект не сохранилась ({msg}). Claude проверит.")
    return False


def post_text(code):
    s = open(f"content/threads/{code}/README.md").read()
    m = re.search(r"^## Пост 1 — .*?\n(.*?)(?=\n## |\Z)", s, re.S | re.M)
    return m.group(1).strip() if m else ""


def already_on_profile(code, date):
    """Return the permalink if this thread's text was already published on `date` (Almaty)."""
    token = os.environ.get("THREADS_ACCESS_TOKEN")
    first = post_text(code).splitlines()[0][:60] if post_text(code) else ""
    if not token or not first:
        return None
    q = urllib.parse.urlencode({"fields": "id,text,permalink,timestamp", "limit": 15, "access_token": token})
    try:
        data = json.load(urllib.request.urlopen(f"https://graph.threads.net/v1.0/me/threads?{q}", timeout=30))["data"]
    except Exception as e:  # no check possible: do not publish blind
        sys.exit(f"cannot check the profile for duplicates: {e}")
    for p in data:
        ts = datetime.datetime.strptime(p["timestamp"], "%Y-%m-%dT%H:%M:%S%z").astimezone(ALMATY)
        if ts.strftime("%Y-%m-%d") == date and (p.get("text") or "").startswith(first):
            return p, ts
    return None


def run(date, hhmm, items, q):
    it = next((x for x in items if x["time"] == hhmm), None)
    if not it:
        sys.exit(f"no slot {hhmm} in {q}")
    if it.get("done"):
        print(f"{it['code']} already done at {it['done']}: {it.get('url')} - nothing to do")
        return
    if not it.get("approved"):
        print(f"{it['code']} is not approved by the owner - not publishing")
        return
    code = it["code"]
    if it["kind"] == "thread":
        dup = already_on_profile(code, date)
        if dup:
            p, ts = dup
            it.update(done=ts.strftime("%H:%M"), url=p["permalink"])
            json.dump(items, open(q, "w"), ensure_ascii=False, indent=1)
            sync_push(f"{code}: already on the profile, queue marked done")
            return
        sha = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        if sh(sys.executable, "tools/publish/job.py", "thread", code, sha, date, hhmm, it["title"]).returncode:
            sys.exit(1)
        if it.get("reply"):
            pid = json.load(open(f"content/threads/{code}/published.json"))["ids"][0]
            sh(sys.executable, "tools/threads/replies.py", "reply", pid, it["reply"])
        sync_push(f"{code}: published")
        return
    slides = sorted(glob.glob(f"content/carousels/{code}/0*.jpg"))
    sh(sys.executable, "tools/telegram/tg.py", "send",
       f"✅ {hhmm} · Карусель {code} «{it['title']}» — загрузите в TikTok вручную ({len(slides)} слайдов ниже), "
       "музыку выберите в приложении. Подпись — следующим сообщением.")
    if sh(sys.executable, "tools/telegram/tg.py", "photos", *slides).returncode:
        sys.exit(1)
    sh(sys.executable, "tools/telegram/tg.py", "send", it["caption"])
    for x in items:
        if x["code"] == code:
            x.update(done=hhmm, url="отправлено в бот для ручной загрузки в TikTok")
    json.dump(items, open(q, "w"), ensure_ascii=False, indent=1)
    sync_push(f"{code}: carousel sent to the bot")


def main(args):
    sh("git", "pull", "-q", "--rebase")
    if args and args[0] == "--due":
        now = datetime.datetime.now(ALMATY)
        date, hhmm_now = now.strftime("%Y-%m-%d"), now.strftime("%H:%M")
        q = f"content/queue/{date}.json"
        if not os.path.exists(q):
            print(f"no queue for {date}")
            return
        for it in json.load(open(q)):
            if it["time"] <= hhmm_now and it.get("approved") and not it.get("done"):
                run(date, it["time"], json.load(open(q)), q)
        return
    date, hhmm = args[0], args[1]
    q = f"content/queue/{date}.json"
    run(date, hhmm, json.load(open(q)), q)


if __name__ == "__main__":
    main(sys.argv[1:])
