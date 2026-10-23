"""Tiny client for the Bikas CRM (Cloudflare Worker, crm/cf/). Standard library only.

  from tools.crm.client import post
  post("/api/hooks/lead", {"source": "Threads", "user": "...", "text": "...", "permalink": "..."})

Env: CRM_URL (https://bikas-crm.<account>.workers.dev; falls back to crm/url.txt, which the deploy workflow
writes) and CRM_API_KEY (sent as X-Api-Key).
If either is missing nothing happens (a note is printed), so workflows keep working before the CRM exists.
Never raises: publishing must not fail because the CRM is down - network and HTTP errors only print a warning.
"""
import json, os, urllib.error, urllib.request

URL_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "crm", "url.txt")


def crm_url():
    url = os.environ.get("CRM_URL", "").strip()
    if not url and os.path.exists(URL_FILE):
        url = open(URL_FILE).read().strip()
    return url.rstrip("/")


def post(path, payload, timeout=20):
    """POST JSON to the CRM. Returns the parsed JSON answer, or None when skipped or failed."""
    url = crm_url()
    key = os.environ.get("CRM_API_KEY", "").strip()
    if not url or not key:
        print("CRM: CRM_URL / CRM_API_KEY not set - skipping")
        return None
    local = url.startswith(("http://localhost", "http://127.0.0.1"))
    if not (url.startswith("https://") or local):
        print("CRM: CRM_URL must be https:// - skipping (the API key would travel in clear text)")
        return None
    try:
        req = urllib.request.Request(
            url + path, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "X-Api-Key": key, "User-Agent": "bikas-crm-client/1"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:  # the answer body is a short error message, never client data
        print(f"CRM: warning - {path} answered HTTP {e.code}")
    except Exception as e:  # DNS, timeout, bad JSON ... the CRM may simply be down
        print(f"CRM: warning - {path} failed: {type(e).__name__}")
    return None
