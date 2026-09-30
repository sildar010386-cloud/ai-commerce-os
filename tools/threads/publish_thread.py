"""Publish an owner-approved Threads draft (content/threads/<code>/README.md) as a reply chain."""
import json, os, re, sys, time, urllib.parse, urllib.request

API = "https://graph.threads.net/v1.0"
TOKEN = os.environ["THREADS_ACCESS_TOKEN"]
RAW = "https://raw.githubusercontent.com/sildar010386-cloud/ai-commerce-os/{sha}/content/threads/{code}/{name}"


def call(method, path, **params):
    params["access_token"] = TOKEN
    data = urllib.parse.urlencode(params).encode()
    url = f"{API}/{path}"
    req = urllib.request.Request(url, data=data if method == "POST" else None, method=method)
    if method == "GET":
        req = urllib.request.Request(url + "?" + data.decode())
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: {e.code} {e.read().decode()[:500]}")


def wait_ready(cid):
    for _ in range(30):
        st = call("GET", cid, fields="status,error_message")
        if st.get("status") == "FINISHED":
            return
        if st.get("status") == "ERROR":
            sys.exit(f"container {cid}: {st}")
        time.sleep(3)
    sys.exit(f"container {cid} not ready")


def parse(readme):
    posts = []
    for m in re.finditer(r"^## Пост \d+ — (.+?)\n(.*?)(?=\n## |\Z)", open(readme).read(), re.S | re.M):
        images = re.findall(r"`([^`]+\.jpg)`", m.group(1))
        posts.append((images, m.group(2).strip()))
    return posts


def main(code, sha, parent=None, start=1):
    """start/parent resume a chain: publish posts from number `start` as replies to `parent`."""
    posts = parse(f"content/threads/{code}/README.md")
    ids = [parent] if parent else []
    for images, text in posts[start - 1:]:
        urls = [RAW.format(sha=sha, code=code, name=n) for n in images]
        extra = {"reply_to_id": parent} if parent else {}
        if len(urls) > 1:
            kids = [call("POST", "me/threads", media_type="IMAGE", image_url=u, is_carousel_item="true")["id"] for u in urls]
            for k in kids:
                wait_ready(k)
            cid = call("POST", "me/threads", media_type="CAROUSEL", children=",".join(kids), text=text, **extra)["id"]
        elif urls:
            cid = call("POST", "me/threads", media_type="IMAGE", image_url=urls[0], text=text, **extra)["id"]
        else:
            cid = call("POST", "me/threads", media_type="TEXT", text=text, **extra)["id"]
        wait_ready(cid)
        new_id = call("POST", "me/threads_publish", creation_id=cid)["id"]
        if parent:  # every post after the first must be a reply to the previous one
            chk = call("GET", new_id, fields="is_reply,replied_to")
            if not chk.get("is_reply") or chk.get("replied_to", {}).get("id") != parent:
                sys.exit(f"post {new_id} is not a reply to {parent}: {chk}. Stopped; fix before continuing.")
        parent = new_id
        ids.append(parent)
        print("published", parent, text.splitlines()[0][:50], flush=True)
        time.sleep(5)
    link = call("GET", ids[0], fields="permalink").get("permalink")
    json.dump({"code": code, "ids": ids, "permalink": link, "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
              open(f"content/threads/{code}/published.json", "w"), ensure_ascii=False, indent=1)
    print("permalink", link)


if __name__ == "__main__":
    # publish_thread.py CODE SHA [PARENT_ID START_NUMBER]
    a = sys.argv[1:]
    main(a[0], a[1], a[2] if len(a) > 2 else None, int(a[3]) if len(a) > 3 else 1)
