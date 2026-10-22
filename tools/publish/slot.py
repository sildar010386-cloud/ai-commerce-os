"""Publish one owner-approved queue slot (content/queue/<date>.json) - the only command a scheduled run needs.

  python3 tools/publish/slot.py 2026-10-23 09:30

thread:    job.py thread (Threads post -> bot notice -> queue done -> commit/push), then our reply under the post
           if the item has "reply" (selling posts: «ПАР» goes only in our reply, owner 2026-10-12).
carousel:  slides content/carousels/<code>/0*.jpg + caption to the bot for a manual TikTok upload, queue done, commit/push.
Refuses to run if the slot is already done (no duplicates, docs/PUBLISHING.md) or not approved by the owner.
"""
import glob, json, subprocess, sys


def sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout + r.stderr, end="", flush=True)
    return r


def main(date, hhmm):
    sh("git", "pull", "-q", "--ff-only")
    q = f"content/queue/{date}.json"
    items = json.load(open(q))
    it = next((x for x in items if x["time"] == hhmm), None)
    if not it:
        sys.exit(f"no slot {hhmm} in {q}")
    if it.get("done"):
        sys.exit(f"{it['code']} already done at {it['done']}: {it.get('url')} - nothing to do")
    if not it.get("approved"):
        sys.exit(f"{it['code']} is not approved by the owner - not publishing")
    code = it["code"]
    if it["kind"] == "thread":
        sha = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        if sh(sys.executable, "tools/publish/job.py", "thread", code, sha, date, hhmm, it["title"]).returncode:
            sys.exit(1)
        if it.get("reply"):
            pid = json.load(open(f"content/threads/{code}/published.json"))["ids"][0]
            sh(sys.executable, "tools/threads/replies.py", "reply", pid, it["reply"])
            sh("git", "add", "-A")
            sh("git", "commit", "-q", "-m", f"{code}: our reply under the post")
            sh("git", "push", "-q", "origin", "HEAD")
        return
    # carousel
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
    sh("git", "add", "-A")
    sh("git", "commit", "-q", "-m", f"{code}: carousel sent to the bot")
    sh("git", "push", "-q", "origin", "HEAD")


if __name__ == "__main__":
    main(*sys.argv[1:3])
