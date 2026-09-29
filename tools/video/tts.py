import base64, json, os, sys, urllib.request
VOICE = os.environ["ELEVENLABS_VOICE_ID"]
def tts(text, out):
    body = json.dumps({"text": text, "model_id": os.environ.get("TTS_MODEL", "eleven_v3"),
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.8}}).encode()
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}/with-timestamps?output_format=mp3_44100_128",
        data=body, headers={"Content-Type": "application/json", "xi-api-key": os.environ.get("ELEVENLABS_API_KEY", "")})
    d = json.load(urllib.request.urlopen(req, timeout=120))
    open(out + ".mp3", "wb").write(base64.b64decode(d["audio_base64"]))
    json.dump(d["alignment"], open(out + ".json", "w"), ensure_ascii=False)
    a = d["alignment"]; print(out, round(a["character_end_times_seconds"][-1], 2))
parts = json.load(open(sys.argv[1]))
for name, text in parts.items():
    if not os.path.exists(name + ".mp3"): tts(text, name)
