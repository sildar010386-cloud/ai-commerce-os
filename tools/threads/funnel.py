"""Funnel step 1 (owner 2026-10-23): someone comments «пар» under our Threads post -> we reply under that comment
with a friendly invitation and a clean wa.me link (owner rule: no UTM, no prefilled text) and tell the owner in the bot.

  python3 tools/threads/funnel.py            reply to every new «пар» comment on our last posts
  python3 tools/threads/funnel.py --dry-run  only print what would be answered

Runs on GitHub Actions every 15 minutes (.github/workflows/funnel.yml on the default branch), no Claude needed.
Stateless: a comment counts as handled when @bikas.home already replied to it, so a re-run never answers twice.
Settings (WhatsApp number, trigger words, reply variants): content/funnel/settings.json. Threads has no DM API, so the link goes
in a public reply. Longer comments that merely contain the word are left to the regular comment replies.
"""
import json, os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_thread import call  # noqa: E402
from replies import ME, reply  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
sys.path.insert(0, os.path.abspath(ROOT))
from tools.crm.client import post as crm_post  # noqa: E402
CFG = json.load(open(os.path.join(ROOT, "content", "funnel", "settings.json")))


def is_keyword(text):
    words = re.findall(r"[a-zа-яё0-9]+", (text or "").lower())
    return 0 < len(words) <= CFG["max_words"] and any(k in words for k in CFG["keywords"])


def new_leads():
    out = []
    for p in call("GET", "me/threads", fields="id,text,permalink", limit=CFG["lookback_posts"]).get("data", []):
        conv = call("GET", f"{p['id']}/conversation", fields="id,text,username,replied_to", limit=100).get("data", [])
        answered = {c.get("replied_to", {}).get("id") for c in conv if c.get("username") == ME}
        for c in conv:
            if c.get("username") != ME and c["id"] not in answered and is_keyword(c.get("text")):
                out.append({"id": c["id"], "user": c.get("username"), "text": c.get("text", ""),
                            "post": (p.get("text") or "").splitlines()[0][:60] if p.get("text") else "",
                            "permalink": p.get("permalink")})
    return out


def main(dry):
    wa = f"wa.me/{CFG['whatsapp']}"
    leads = new_leads()
    for i, c in enumerate(leads):
        text = CFG["replies"][int(c["id"]) % len(CFG["replies"])].format(wa=wa)
        print(json.dumps(c, ensure_ascii=False), "->", text)
        if dry:
            continue
        reply(c["id"], text)
        crm_post("/api/hooks/lead", {"source": "Threads", "user": c["user"], "text": c["text"], "permalink": c["permalink"]})
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "telegram", "tg.py"), "send",
                        f"🔥 Threads: @{c['user']} написал «{c['text']}» под постом «{c['post']}».\n"
                        f"Ответили ссылкой на WhatsApp (+{CFG['whatsapp']}) — ждите сообщения.\n{c['permalink']}"])
    print(f"{len(leads)} new keyword comment(s)")


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
