"""Funnel step 1 for Instagram (owner 2026-10-26): a short comment with a trigger word («пар») under our post or
reel -> a private reply (Instagram DM to the commenter) with the clean wa.me link, a short public reply under the
comment, 🔥 to the owner's bot and a lead in the CRM.

  python3 tools/instagram/funnel_ig.py            handle new trigger comments on our last posts
  python3 tools/instagram/funnel_ig.py --dry-run  only print what would be handled

Links in Instagram comments are not clickable, so the link goes in the private reply; if Instagram refuses it
(missing permission or the 7-day window), the public reply points to the WhatsApp link in the profile instead.
Stateless like the Threads funnel: a comment counts as handled once @bikas.home has replied under it.
Runs on GitHub Actions with funnel.yml (secret IG_ACCESS_TOKEN). Settings: content/funnel/settings.json.
"""
import json, os, subprocess, sys, urllib.error, urllib.parse, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
sys.path.insert(0, os.path.abspath(ROOT))
sys.path.insert(0, os.path.join(os.path.abspath(ROOT), "tools", "threads"))
from tools.crm.client import post as crm_post  # noqa: E402
from funnel import CFG, is_keyword  # noqa: E402  (shared trigger-word rules with the Threads funnel)

API = "https://graph.instagram.com/v23.0"
ME = "bikas.home"


def api(method, path, **params):
    params["access_token"] = os.environ["IG_ACCESS_TOKEN"]
    data = urllib.parse.urlencode(params).encode()
    url = f"{API}/{path}" + ("" if method == "POST" else "?" + data.decode())
    req = urllib.request.Request(url, data=data if method == "POST" else None, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def new_leads():
    out = []
    for m in api("GET", "me/media", fields="id,caption,permalink", limit=CFG["lookback_posts"]).get("data", []):
        comments = api("GET", f"{m['id']}/comments", fields="id,text,username,replies{username}", limit=50).get("data", [])
        for c in comments:
            answered = any(r.get("username") == ME for r in c.get("replies", {}).get("data", []))
            if c.get("username") != ME and not answered and is_keyword(c.get("text")):
                out.append({"id": c["id"], "user": c.get("username"), "text": c.get("text", ""),
                            "post": (m.get("caption") or "").splitlines()[0][:60] if m.get("caption") else "",
                            "permalink": m.get("permalink")})
    return out


def pick(key, cid):
    return CFG[key][int(cid) % len(CFG[key])]


def main(dry):
    wa = f"wa.me/{CFG['whatsapp']}"
    leads = new_leads()
    for c in leads:
        print(json.dumps(c, ensure_ascii=False))
        if dry:
            continue
        try:  # private reply: a DM to the commenter, allowed once per comment within 7 days
            api("POST", "me/messages", recipient=json.dumps({"comment_id": c["id"]}),
                message=json.dumps({"text": pick("instagram_dm", c["id"]).format(wa=wa)}))
            public, how = pick("instagram_public", c["id"]), "ссылку отправили в директ"
        except urllib.error.HTTPError as e:
            print("private reply refused:", e.code, e.read().decode("utf-8", "replace")[:200])
            public, how = pick("instagram_public_fallback", c["id"]), "в директ не пустило — ответили, что ссылка в шапке профиля"
        api("POST", f"{c['id']}/replies", message=public)
        crm_post("/api/hooks/lead", {"source": "Instagram", "user": c["user"], "text": c["text"], "permalink": c["permalink"]})
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "telegram", "tg.py"), "send",
                        f"🔥 Instagram: @{c['user']} написал «{c['text']}» под постом «{c['post']}».\n"
                        f"{how.capitalize()} (WhatsApp +{CFG['whatsapp']}) — ждите сообщения.\n{c['permalink']}"])
    print(f"{len(leads)} new keyword comment(s)")


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
