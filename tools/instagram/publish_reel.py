"""Publish an owner-approved Reel via the Instagram API.

Instagram Login tokens need a public video_url (resumable upload is rejected), so commit the
approved MP4 and pass its raw.githubusercontent.com URL pinned to the commit SHA.

Usage: publish_reel.py VIDEO_URL CAPTION.txt OUT.json
"""
import json, os, sys, time, urllib.parse, urllib.request

API = "https://graph.instagram.com/v23.0"
TOKEN = os.environ["IG_ACCESS_TOKEN"]


def req(method, url, data=None, headers=None):
    r = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        return json.load(urllib.request.urlopen(r, timeout=300))
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url.split('?')[0]}: {e.code} {e.read().decode()[:500]}")


def api(method, path, **params):
    params["access_token"] = TOKEN
    q = urllib.parse.urlencode(params)
    if method == "GET":
        return req("GET", f"{API}/{path}?{q}")
    return req("POST", f"{API}/{path}", data=q.encode())


def main(video, caption_file, out):
    caption = open(caption_file).read().strip()
    me = api("GET", "me", fields="user_id,username")
    cid = api("POST", f"{me['user_id']}/media", media_type="REELS", video_url=video,
              caption=caption, share_to_feed="true")["id"]
    print("container", cid)
    for _ in range(60):
        st = api("GET", cid, fields="status_code,status")
        print("status", st.get("status_code"), flush=True)
        if st.get("status_code") == "FINISHED":
            break
        if st.get("status_code") in ("ERROR", "EXPIRED"):
            sys.exit(f"container failed: {st}")
        time.sleep(10)
    else:
        sys.exit("container not ready in time")
    media = api("POST", f"{me['user_id']}/media_publish", creation_id=cid)
    info = api("GET", media["id"], fields="id,permalink,timestamp,media_product_type")
    json.dump(info, open(out, "w"), ensure_ascii=False, indent=1)
    print("published", info)


if __name__ == "__main__":
    main(*sys.argv[1:4])
