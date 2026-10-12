"""Threads comments: list unanswered comments on our posts and reply to them as @bikas.home.

  python3 tools/threads/replies.py list [N_POSTS]     unanswered comments from others (JSON lines)
  python3 tools/threads/replies.py reply ID "text"    publish a reply to comment ID, log it

Owner decision 2026-10-12: Claude answers every comment himself, without asking first, at every check.
Replies are logged to content/comments/threads.jsonl.
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_thread import call, wait_ready  # noqa: E402

ME = "bikas.home"
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "content", "comments", "threads.jsonl")


def unanswered(n=30):
    out = []
    for p in call("GET", "me/threads", fields="id,text,permalink,timestamp", limit=n).get("data", []):
        conv = call("GET", f"{p['id']}/conversation", fields="id,text,username,timestamp,replied_to").get("data", [])
        answered = {c.get("replied_to", {}).get("id") for c in conv if c.get("username") == ME}
        for c in conv:
            if c.get("username") != ME and c["id"] not in answered:
                out.append({"id": c["id"], "user": c.get("username"), "text": c.get("text", ""), "at": c["timestamp"],
                            "post": p["text"].splitlines()[0][:80], "permalink": p.get("permalink")})
    return out


def reply(cid, text):
    container = call("POST", "me/threads", media_type="TEXT", text=text, reply_to_id=cid)["id"]
    wait_ready(container)
    new_id = call("POST", "me/threads_publish", creation_id=container)["id"]
    link = call("GET", new_id, fields="permalink").get("permalink")
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "to": cid, "id": new_id,
                            "text": text, "permalink": link}, ensure_ascii=False) + "\n")
    print("replied", new_id, link)


if __name__ == "__main__":
    if sys.argv[1] == "list":
        for c in unanswered(int(sys.argv[2]) if len(sys.argv) > 2 else 30):
            print(json.dumps(c, ensure_ascii=False))
    else:
        reply(sys.argv[2], sys.argv[3])
