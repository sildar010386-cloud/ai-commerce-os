"""TikTok (sandbox app "Bikas Home Publisher") helper: OAuth, token storage, stats, posting.

Owner decision 2026-09-30: TikTok tokens and one-time auth codes are kept in the owner's
PRIVATE repo sildar010386-cloud/bikas-music (clone at $BIKAS_MUSIC, default /home/user/bikas-music;
the session needs add_repo access=push). Never print tokens.

  tt.py url        authorization link for the owner (redirect -> docs/tiktok/callback.html)
  tt.py exchange   newest bikas-music/tiktok/code-* -> tokens (secrets/tiktok_token.json), code deleted
  tt.py refresh    refresh the access token (24 h); refresh token lives 365 days
  tt.py me         profile + stats
  tt.py videos     own videos with views/likes/comments/shares
  tt.py creator    creator_info (privacy options, limits) required before a direct post
  tt.py draft F    upload video file F to the TikTok inbox as a draft (owner finishes the post in the app;
                   works without app audit, max 5 pending drafts per 24 h). Only for owner-approved videos.
  tt.py photos CODE CAPTION.txt [--direct]
                   send content/threads/CODE/carousel/*.jpg to the TikTok inbox as a photo-carousel draft with
                   the caption (first line = title, rest = description). TikTok pulls photos only from the verified
                   prefix PAGES (GitHub Pages, branch claude/ai-ecommerce-automation-3n1lgz, docs/tiktok/media/CODE/).
                   --direct: post straight to the profile instead (unaudited app: SELF_ONLY; the owner switches it
                   to "Everyone" in the app), with TikTok's auto-added music.
  tt.py status ID  status of an upload by publish_id
"""
import glob, json, os, subprocess, sys, time, urllib.parse, urllib.request

API = "https://open.tiktokapis.com/v2"
REDIRECT = "https://sildar010386-cloud.github.io/ai-commerce-os/tiktok/callback.html"
SCOPES = "user.info.basic,user.info.profile,user.info.stats,video.list,video.upload,video.publish"
REPO = os.environ.get("BIKAS_MUSIC", "/home/user/bikas-music")
TOKEN_FILE = os.path.join(REPO, "secrets", "tiktok_token.json")
PAGES = "https://sildar010386-cloud.github.io/ai-commerce-os/tiktok/media/"


def git(*args):
    subprocess.run(["git", "-C", REPO, *args], check=True, capture_output=True)


def push(msg):
    git("add", "-A")
    git("commit", "-m", msg)
    git("push", "origin", "HEAD:main")


def post_form(url, data):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        sys.exit(f"{url}: HTTP {e.code} {e.read().decode()[:300]}")


def keys():
    return {"client_key": os.environ["TIKTOK_CLIENT_KEY"], "client_secret": os.environ["TIKTOK_CLIENT_SECRET"]}


def save_tokens(tok, msg):
    tok["saved_at"] = int(time.time())
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        json.dump(tok, f, indent=1)
    push(msg)


def refresh():
    old = json.load(open(TOKEN_FILE))
    tok = post_form(f"{API}/oauth/token/", {**keys(), "grant_type": "refresh_token",
                                             "refresh_token": old["refresh_token"]})
    if "access_token" not in tok:
        sys.exit(f"refresh failed: {tok.get('error')} {tok.get('error_description')}")
    save_tokens(tok, "Refresh TikTok token")
    return tok


def access_token():
    git("pull", "-q", "origin", "main")
    tok = json.load(open(TOKEN_FILE))
    if time.time() > tok["saved_at"] + tok.get("expires_in", 86400) - 1800:
        tok = refresh()
    return tok["access_token"]


def api(method, path, params=None, body=None):
    url = f"{API}/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {access_token()}",
                                          "Content-Type": "application/json; charset=UTF-8"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        sys.exit(f"{path}: HTTP {e.code} {e.read().decode()[:300]}")


def draft(path):
    size = os.path.getsize(path)
    # TikTok chunks: 5-64 MB each, the last one takes the remainder (up to 128 MB); small files go whole.
    chunk = size if size <= 64 * 2**20 else 10 * 2**20
    count = size // chunk
    r = api("POST", "post/publish/inbox/video/init/", body={"source_info": {
        "source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk, "total_chunk_count": count}})
    if r.get("error", {}).get("code") != "ok":
        sys.exit(f"init failed: {r.get('error')}")
    with open(path, "rb") as f:
        for i in range(count):
            start = i * chunk
            end = size if i == count - 1 else start + chunk
            f.seek(start)
            req = urllib.request.Request(r["data"]["upload_url"], data=f.read(end - start), method="PUT",
                                         headers={"Content-Type": "video/mp4",
                                                  "Content-Range": f"bytes {start}-{end - 1}/{size}"})
            try:
                urllib.request.urlopen(req, timeout=600)
            except urllib.error.HTTPError as e:
                sys.exit(f"upload chunk {i}: HTTP {e.code} {e.read().decode()[:300]}")
    print("uploaded; publish_id:", r["data"]["publish_id"], "- owner finishes the post in the TikTok app inbox")


def photos(code, caption_file, direct=False):
    names = sorted(n for n in os.listdir(f"content/threads/{code}/carousel") if n.endswith(".jpg"))
    title, _, description = open(caption_file).read().strip().partition("\n")
    info = {"title": title[:90], "description": description.strip()}
    if direct:
        info.update(privacy_level="SELF_ONLY", disable_comment=False, auto_add_music=True)
    r = api("POST", "post/publish/content/init/", body={
        "post_mode": "DIRECT_POST" if direct else "MEDIA_UPLOAD", "media_type": "PHOTO",
        "post_info": info,
        "source_info": {"source": "PULL_FROM_URL", "photo_cover_index": 0,
                        "photo_images": [f"{PAGES}{code}/{n}" for n in names]}})
    if r.get("error", {}).get("code") != "ok":
        sys.exit(f"photo init failed: {r.get('error')}")
    print("sent; publish_id:", r["data"]["publish_id"],
          "- posted as SELF_ONLY" if direct else "- owner finishes the post in the TikTok app inbox")


def main(cmd):
    if cmd == "url":
        q = {"client_key": os.environ["TIKTOK_CLIENT_KEY"], "scope": SCOPES, "response_type": "code",
             "redirect_uri": REDIRECT, "state": str(int(time.time()))}
        print("https://www.tiktok.com/v2/auth/authorize/?" + urllib.parse.urlencode(q))
    elif cmd == "exchange":
        git("pull", "-q", "origin", "main")
        codes = sorted(glob.glob(os.path.join(REPO, "tiktok", "code-*")))  # manual uploads may end in "."
        if not codes:
            sys.exit("no code file in bikas-music/tiktok/ yet")
        code = open(codes[-1]).read().strip()
        tok = post_form(f"{API}/oauth/token/", {**keys(), "code": code,
                                                 "grant_type": "authorization_code", "redirect_uri": REDIRECT})
        for c in codes:
            os.remove(c)
        if "access_token" not in tok:
            push("Remove used TikTok auth code")
            sys.exit(f"exchange failed: {tok.get('error')} {tok.get('error_description')}")
        save_tokens(tok, "Store TikTok tokens; remove used auth code")
        print("ok; scopes:", tok.get("scope"), "| refresh valid (s):", tok.get("refresh_expires_in"))
    elif cmd == "refresh":
        print("ok; expires_in", refresh().get("expires_in"))
    elif cmd == "me":
        print(json.dumps(api("GET", "user/info/", {"fields": "open_id,display_name,username,profile_deep_link,"
              "follower_count,following_count,likes_count,video_count"}), ensure_ascii=False, indent=1))
    elif cmd == "videos":
        print(json.dumps(api("POST", "video/list/", {"fields": "id,title,create_time,duration,share_url,"
              "view_count,like_count,comment_count,share_count"}, {"max_count": 20}), ensure_ascii=False, indent=1))
    elif cmd == "creator":
        print(json.dumps(api("POST", "post/publish/creator_info/query/", body={}), ensure_ascii=False, indent=1))
    elif cmd == "draft":
        draft(sys.argv[2])
    elif cmd == "photos":
        photos(sys.argv[2], sys.argv[3], "--direct" in sys.argv[4:])
    elif cmd == "status":
        print(json.dumps(api("POST", "post/publish/status/fetch/", body={"publish_id": sys.argv[2]}),
                         ensure_ascii=False, indent=1))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
