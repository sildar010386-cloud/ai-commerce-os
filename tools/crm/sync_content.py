"""Mirror the publishing queue (content/queue/<date>.json) into the CRM «Контент» tab.

  python3 tools/crm/sync_content.py              today-7 ... today+14 (Asia/Almaty)
  python3 tools/crm/sync_content.py error DATE HH:MM "text"   mark one slot «ошибка» (shown in red)

The CRM derives the status itself: done -> «вышел» («в боте» for carousels), approved and not done -> «ждёт»,
not approved -> «не одобрено». Does nothing (prints a note) when CRM_URL / CRM_API_KEY are not set.
"""
import datetime, glob, json, os, sys
from zoneinfo import ZoneInfo

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, ROOT)
from tools.crm.client import post  # noqa: E402

ALMATY = ZoneInfo("Asia/Almaty")
FIELDS = ("time", "code", "kind", "type", "title", "approved", "done", "url")


def collect(today=None, root=ROOT):
    today = today or datetime.datetime.now(ALMATY).date()
    items = []
    for offset in range(-7, 15):
        date = (today + datetime.timedelta(days=offset)).isoformat()
        path = os.path.join(root, "content", "queue", f"{date}.json")
        if not os.path.exists(path):
            continue
        try:
            queue = json.load(open(path))
        except Exception as e:
            print(f"CRM: cannot read {path}: {type(e).__name__}")
            continue
        for it in queue:
            row = {k: it.get(k) for k in FIELDS if it.get(k) is not None}
            row["date"] = date
            row["approved"] = bool(it.get("approved"))
            items.append(row)
    return items


def main(root=ROOT):
    items = collect(root=root)
    if not items:
        print("CRM: no queue files in the window - nothing to sync")
        return None
    r = post("/api/hooks/content-sync", {"items": items})
    if r:
        print(f"CRM: synced {len(items)} slot(s)")
    return r


def report_error(date, hhmm, text):
    return post("/api/hooks/content-status", {"date": date, "time": hhmm, "status": "ошибка", "url": str(text)[:300]})


if __name__ == "__main__":
    if len(sys.argv) >= 5 and sys.argv[1] == "error":
        report_error(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        main()
