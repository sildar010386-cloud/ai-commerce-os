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


def main(code, sha):
    posts = parse(f"content/threads/{code}/README.md")
    parent, ids = None, []
    for images, text in posts:
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
        parent = call("POST", "me/threads_publish", creation_id=cid)["id"]
        ids.append(parent)
        print("published", parent, text.splitlines()[0][:50], flush=True)
        time.sleep(5)
    link = call("GET", ids[0], fields="permalink").get("permalink")
    json.dump({"code": code, "ids": ids, "permalink": link, "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
              open(f"content/threads/{code}/published.json", "w"), ensure_ascii=False, indent=1)
    print("permalink", link)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
