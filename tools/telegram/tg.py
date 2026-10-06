"""Telegram bot @bikas_content_bot: the owner's channel for daily packages, approvals and reports.

  tg.py send "text"                 message to the owner
  tg.py video FILE.mp4 "caption"    video with a caption (<= 1024 chars)
  tg.py photos A.jpg B.jpg ...      album (2-10 photos)
  tg.py file FILE "caption"         any document
  tg.py inbox                       new messages from the owner since the last call (attached files are saved
                                    to /home/user/work/inbox, TG_DOWNLOADS); voice messages are
                                    transcribed with ElevenLabs speech-to-text. Prints one JSON per line.

Token: env TELEGRAM_BOT_TOKEN (host api.telegram.org must be allowed). The owner's chat id and the update
offset live in the PRIVATE repo bikas-music (secrets/telegram.json), not in this public repo. The first chat
that sends /start becomes the owner; messages from any other chat are ignored.
"""
import json, os, subprocess, sys, urllib.parse, urllib.request

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
API = f"https://api.telegram.org/bot{TOKEN}"
REPO = os.environ.get("BIKAS_MUSIC", "/home/user/bikas-music")
STATE = os.path.join(REPO, "secrets", "telegram.json")
DOWNLOADS = os.environ.get("TG_DOWNLOADS", "/home/user/work/inbox")  # files the owner sends to the bot


def git(*args):
    # pull/push may fail when GitHub access to the private repo is lost: keep working on the local copy
    r = subprocess.run(["git", "-C", REPO, *args], check=args[0] not in ("pull", "push"), capture_output=True)
    if r.returncode:
        print(f"warning: git {args[0]} failed for {REPO}, using the local copy", file=sys.stderr)


def load():
    git("pull", "-q", "origin", "main")
    return json.load(open(STATE)) if os.path.exists(STATE) else {"offset": 0}


def save(state, msg):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(state, open(STATE, "w"), indent=1)
    git("add", STATE)
    if subprocess.run(["git", "-C", REPO, "diff", "--cached", "--quiet"]).returncode:
        git("commit", "-m", msg)
        git("push", "origin", "HEAD:main")


def call(method, **params):
    data = urllib.parse.urlencode(params).encode()
    r = json.load(urllib.request.urlopen(f"{API}/{method}", data=data, timeout=60))
    if not r.get("ok"):
        sys.exit(f"{method}: {r}")
    return r["result"]


def upload(method, chat, fields, files):
    """Multipart upload via curl (videos up to 50 MB)."""
    cmd = ["curl", "-sS", "-X", "POST", f"{API}/{method}", "--form-string", f"chat_id={chat}"]
    for k, v in fields.items():  # --form-string: a caption starting with "@" must not be read as a file
        cmd += ["--form-string", f"{k}={v}"]
    for k, path in files.items():
        cmd += ["-F", f"{k}=@{path}"]
    r = json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)
    if not r.get("ok"):
        sys.exit(f"{method}: {r}")
    return r["result"]


def owner():
    chat = load().get("chat_id")
    if not chat:
        sys.exit("owner has not sent /start to the bot yet")
    return chat


def transcribe(file_id):
    path = call("getFile", file_id=file_id)["file_path"]
    local = "/tmp/tg_voice_" + os.path.basename(path)
    urllib.request.urlretrieve(f"https://api.telegram.org/file/bot{TOKEN}/{path}", local)
    out = subprocess.run(["curl", "-sS", "-X", "POST", "https://api.elevenlabs.io/v1/speech-to-text",
                          "-H", f"xi-api-key: {os.environ.get('ELEVENLABS_API_KEY', '')}",
                          "-F", "model_id=scribe_v1", "-F", "language_code=rus", "-F", f"file=@{local}"],
                         capture_output=True, text=True).stdout
    try:
        return json.loads(out).get("text") or f"[не удалось расшифровать: {out[:200]}]"
    except json.JSONDecodeError:
        return f"[не удалось расшифровать: {out[:200]}]"


def inbox():
    state = load()
    updates = call("getUpdates", offset=state.get("offset", 0), timeout=0)
    for u in updates:
        state["offset"] = u["update_id"] + 1
        m = u.get("message") or {}
        chat = m.get("chat", {}).get("id")
        if not chat:
            continue
        if not state.get("chat_id") and (m.get("text") or "").startswith("/start"):
            state["chat_id"] = chat
            call("sendMessage", chat_id=chat, text="Готово: бот подключён, сюда будут приходить материалы на согласование и отчёты.")
        if chat != state.get("chat_id"):
            continue
        item = {"date": m.get("date"), "text": m.get("text") or m.get("caption") or ""}
        if m.get("voice") or m.get("audio"):
            item["voice"] = transcribe((m.get("voice") or m.get("audio"))["file_id"])
        if m.get("photo") or m.get("video") or m.get("document"):
            item["attachment"] = True
            # the update is consumed here, so save the file now: the Bot API serves files up to 20 MB
            f = m.get("video") or m.get("document") or m["photo"][-1]
            try:
                path = call("getFile", file_id=f["file_id"])["file_path"]
                os.makedirs(DOWNLOADS, exist_ok=True)
                item["file"] = os.path.join(DOWNLOADS, f"{u['update_id']}_{f.get('file_name') or os.path.basename(path)}")
                urllib.request.urlretrieve(f"https://api.telegram.org/file/bot{TOKEN}/{path}", item["file"])
            except Exception as e:
                item["file_error"] = str(e)[:200]
        print(json.dumps(item, ensure_ascii=False))
    save(state, "Update Telegram bot state")


def main(cmd, args):
    if cmd == "inbox":
        inbox()
    elif cmd == "send":
        call("sendMessage", chat_id=owner(), text=args[0])
    elif cmd == "video":
        upload("sendVideo", owner(), {"caption": args[1] if len(args) > 1 else "", "supports_streaming": "true"},
               {"video": args[0]})
    elif cmd == "file":
        upload("sendDocument", owner(), {"caption": args[1] if len(args) > 1 else ""}, {"document": args[0]})
    elif cmd == "photos":
        media = [{"type": "photo", "media": f"attach://p{i}"} for i in range(len(args))]
        upload("sendMediaGroup", owner(), {"media": json.dumps(media)}, {f"p{i}": a for i, a in enumerate(args)})
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "", sys.argv[2:])
