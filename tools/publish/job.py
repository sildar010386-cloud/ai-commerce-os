"""One queued publication from content/queue/<date>.json, end to end (docs/DAILY_ROUTINE.md §2).

  python3 tools/publish/job.py reel REEL-07 SHA DATE "HH:MM" "Title for the bot"
  python3 tools/publish/job.py thread T-12 SHA DATE "HH:MM" "Title for the bot"

reel:   Reels (MP4 pinned to commit SHA) -> caption check -> Stories -> TikTok video draft -> bot notice + caption message.
thread: Threads chain -> /conversation check -> carousel slides to the bot for a manual TikTok upload -> notice.
Then marks the queue item done, updates the README status line and commits + pushes. Every step's output is printed
in full (no tail: see docs/ERRORS.md, T-09).
"""
import json, re, subprocess, sys, urllib.request

REPO = "sildar010386-cloud/ai-commerce-os"


def sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout + r.stderr, end="", flush=True)
    return r


def tg(*args):
    return sh(sys.executable, "tools/telegram/tg.py", *args)


def get(url):
    return json.load(urllib.request.urlopen(url, timeout=60))


def reel(code, sha):
    import os
    folder = f"content/reels/{code}"
    mp4 = next(f"{folder}/{n}" for n in sorted(os.listdir(folder)) if n.endswith("_muzyka.mp4"))
    url = f"https://raw.githubusercontent.com/{REPO}/{sha}/{mp4}"
    cap = f"{folder}/caption.txt"
    if sh(sys.executable, "tools/instagram/publish_reel.py", url, cap, f"{folder}/published.json").returncode:
        tg("send", f"❌ {code}: Reels не опубликован, разбираюсь.")
        sys.exit(1)
    pub = json.load(open(f"{folder}/published.json"))
    tok = os.environ["IG_ACCESS_TOKEN"]
    got = get(f"https://graph.instagram.com/v23.0/{pub['id']}?fields=caption&access_token={tok}").get("caption", "")
    ok = got == open(cap).read().strip()
    story = sh(sys.executable, "tools/instagram/publish_reel.py", url, cap, f"{folder}/story_published.json", "--story")
    draft = sh(sys.executable, "tools/tiktok/tt.py", "draft", mp4)
    tiktok = ("черновик видео отправлен, придёт уведомление. Подпись — следующим сообщением."
              if "uploaded" in draft.stdout else "⚠️ черновик не принят — загрузите видео вручную (файл ниже), подпись — следующим сообщением.")
    return pub["permalink"], ok, story.returncode == 0, tiktok, mp4, cap


def thread(code, sha):
    r = sh(sys.executable, "tools/threads/publish_thread.py", code, sha)
    pub = json.load(open(f"content/threads/{code}/published.json"))
    if r.returncode or not pub.get("complete"):
        tg("send", f"❌ {code}: ветка опубликована не полностью ({len(pub.get('ids', []))} пост.), разбираюсь.")
        sys.exit(1)
    import os
    tok = os.environ["THREADS_ACCESS_TOKEN"]
    conv = get(f"https://graph.threads.net/v1.0/{pub['ids'][0]}/conversation?fields=id,replied_to&access_token={tok}")
    links = {x["id"]: x.get("replied_to", {}).get("id") for x in conv.get("data", [])}
    chain_ok = len(links) == len(pub["ids"]) - 1 and all(links.get(c) == p for p, c in zip(pub["ids"], pub["ids"][1:]))
    # photo drafts reach SEND_TO_USER_INBOX but never show up in the owner's app (ERRORS 2026-10-01 TT-02, 2026-10-09):
    # carousels go to the bot as slides for a manual upload instead
    # only the threads picked for TikTok have slides (owner 2026-10-10: 2 carousels a day, 1 reach + 1 selling)
    has_slides = os.path.isdir(f"content/threads/{code}/carousel")
    tiktok = ("слайды карусели ниже — загрузите вручную, без описания, музыку выберите в приложении." if has_slides
              else "без карусели (в TikTok идут 2 ветки в день).")
    return pub["permalink"], chain_ok, len(pub["ids"]), tiktok, not has_slides


def main(kind, code, sha, date, hhmm, title):
    if kind == "reel":
        link, cap_ok, story_ok, tiktok, mp4, cap = reel(code, sha)
        tg("send", f"✅ Опубликовано: {hhmm} · Ролик {code} «{title}»\nReels: {link}"
                   f"{'' if cap_ok else ' (⚠️ подпись отличается — проверяю)'}\n"
                   f"Stories: {'опубликовано' if story_ok else '⚠️ не вышло'}\nTikTok: {tiktok}")
        if "не принят" in tiktok:
            tg("video", mp4, "Файл для ручной загрузки в TikTok")
        tg("send", open(cap).read().strip())
    else:
        link, chain_ok, n, tiktok, sent = thread(code, sha)
        tg("send", f"✅ Опубликовано: {hhmm} · Ветка {code} «{title}»\nThreads: {link} "
                   f"({n} пост., цепочка {'проверена' if chain_ok else '⚠️ НЕ совпадает — проверяю'})\nTikTok: {tiktok}")
        if not sent:  # sent=True here means "no slides to send"
            import glob
            tg("photos", *sorted(glob.glob(f"content/threads/{code}/carousel/*.jpg")))
    q = f"content/queue/{date}.json"
    items = json.load(open(q))
    for it in items:
        if it["code"] == code:
            it.update(done=hhmm, url=link)
    json.dump(items, open(q, "w"), ensure_ascii=False, indent=1)
    folder = f"content/{'reels' if kind == 'reel' else 'threads'}/{code}"
    s = open(f"{folder}/README.md").read()
    s = re.sub(r"^Статус: .*$", f"Статус: **опубликовано {date} {hhmm} Алматы** (одобрено владельцем): {link}.", s, count=1, flags=re.M)
    open(f"{folder}/README.md", "w").write(s)
    sh("git", "add", "-A")
    sh("git", "commit", "-q", "-m", f"Publish {code}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"
                                     "Claude-Session: https://claude.ai/code/session_01VFufGzxidoqzfwSHwp3Azx")
    sh("git", "push", "-q", "origin", "HEAD")


if __name__ == "__main__":
    main(*sys.argv[1:7])
