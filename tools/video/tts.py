import base64, json, os, sys, urllib.request
# Owner-approved voices and settings, see content/voice/VOICE.md. TTS_VOICE picks the preset.
PRESETS = {
    "larisa": ("AB9XsbSA4eLG12t2myjN",  # ElevenLabs library voice "Larisa Actrisa", chosen 2026-10-01 (variant L2)
               {"stability": 0.45, "similarity_boost": 0.8, "style": 0.4, "use_speaker_boost": True, "speed": 0.88}),
    "owner": (os.environ.get("ELEVENLABS_VOICE_ID", ""),  # owner's clone, approved 2026-09-30
              {"stability": 0.5, "similarity_boost": 0.8, "style": 0.2, "use_speaker_boost": True}),
}
VOICE, SETTINGS = PRESETS[os.environ.get("TTS_VOICE", "larisa")]
def tts(text, out):
    body = json.dumps({"text": text, "model_id": os.environ.get("TTS_MODEL", "eleven_multilingual_v2"),
        "voice_settings": SETTINGS}).encode()
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}/with-timestamps?output_format=mp3_44100_128",
        data=body, headers={"Content-Type": "application/json", "xi-api-key": os.environ.get("ELEVENLABS_API_KEY", "")})
    d = json.load(urllib.request.urlopen(req, timeout=120))
    open(out + ".mp3", "wb").write(base64.b64decode(d["audio_base64"]))
    json.dump(d["alignment"], open(out + ".json", "w"), ensure_ascii=False)
    a = d["alignment"]; print(out, round(a["character_end_times_seconds"][-1], 2))
parts = json.load(open(sys.argv[1]))
for name, text in parts.items():
    if not os.path.exists(name + ".mp3"): tts(text, name)
