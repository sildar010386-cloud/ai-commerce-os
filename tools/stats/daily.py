"""Daily stats snapshot for Instagram, Threads and TikTok -> content/stats/<UTC date>.json + a printed table.

  python3 tools/stats/daily.py

Run at the start of each work session; compare with earlier snapshots before planning new content
(CONTENT_PLAYBOOK.md §13). Key numbers: IG average watch time (hook strength), Threads read-through
(last post views / first post views), views per video vs the ~150-view test pool.
"""
import glob, json, os, subprocess, sys, time, urllib.parse, urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
IG = "https://graph.instagram.com/v23.0"
TH = "https://graph.threads.net/v1.0"


def get(url, **params):
    try:
        return json.load(urllib.request.urlopen(f"{url}?{urllib.parse.urlencode(params)}", timeout=60))
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()[:200]}


def insights(base, mid, token, metrics):
    r = get(f"{base}/{mid}/insights", metric=metrics, access_token=token)
    return {d["name"]: d["values"][0]["value"] for d in r.get("data", [])}


def instagram():
    t = os.environ["IG_ACCESS_TOKEN"]
    me = get(f"{IG}/me", fields="followers_count,media_count", access_token=t)
    media = get(f"{IG}/me/media", fields="id,media_product_type,timestamp,permalink,caption", limit=50,
                access_token=t).get("data", [])
    for m in media:
        m["caption"] = (m.get("caption") or "")[:60]
        m["insights"] = insights(IG, m["id"], t, "views,reach,saved,shares,likes,comments,ig_reels_avg_watch_time")
    return {"followers": me.get("followers_count"), "media": media}


def threads():
    t = os.environ["THREADS_ACCESS_TOKEN"]
    out = []
    for f in sorted(glob.glob(os.path.join(ROOT, "content", "threads", "*", "published.json"))):
        pub = json.load(open(f))
        posts = [insights(TH, i, t, "views,likes,replies,reposts,quotes,shares") for i in pub["ids"]]
        first, last = posts[0].get("views") or 0, posts[-1].get("views") or 0
        out.append({"code": pub["code"], "published_at": pub.get("published_at"), "posts": posts,
                    "read_through": round(last / first, 3) if first else None})
    return out


def tiktok():
    tt = [sys.executable, os.path.join(ROOT, "tools", "tiktok", "tt.py")]
    me = json.loads(subprocess.run(tt + ["me"], capture_output=True, text=True, check=True).stdout)["data"]["user"]
    videos = json.loads(subprocess.run(tt + ["videos"], capture_output=True, text=True, check=True).stdout)
    return {"followers": me["follower_count"], "videos": videos["data"]["videos"]}


def main():
    snap = {"taken_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "instagram": instagram(), "threads": threads(), "tiktok": tiktok()}
    path = os.path.join(ROOT, "content", "stats", time.strftime("%Y-%m-%d", time.gmtime()) + ".json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(snap, open(path, "w"), ensure_ascii=False, indent=1)

    ig = snap["instagram"]
    print(f"Instagram: {ig['followers']} followers")
    for m in ig["media"][:10]:
        i = m["insights"]
        print(f"  {m['timestamp'][:16]} {m['media_product_type']:6} views {i.get('views')} reach {i.get('reach')} "
              f"avg_watch {(i.get('ig_reels_avg_watch_time') or 0) / 1000:.1f}s saved {i.get('saved')} "
              f"shares {i.get('shares')} | {m['caption'][:35]}")
    print("Threads:")
    for th in snap["threads"]:
        print(f"  {th['code']} {th['published_at']} views {[p.get('views') for p in th['posts']]} "
              f"read-through {th['read_through']}")
    tk = snap["tiktok"]
    print(f"TikTok: {tk['followers']} followers")
    for v in sorted(tk["videos"], key=lambda v: -v["create_time"])[:10]:
        print(f"  {time.strftime('%m-%d %H:%M', time.gmtime(v['create_time']))} {v['duration']}s views {v['view_count']} "
              f"likes {v['like_count']} comments {v['comment_count']} shares {v['share_count']} "
              f"| {(v.get('title') or '')[:35]}")
    print("saved", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
