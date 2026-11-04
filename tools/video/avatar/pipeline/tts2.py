import base64, json, os, sys, urllib.request
seed = int(sys.argv[1]); out = sys.argv[2]
TEXT = open("/tmp/facework/reel02/text.txt").read().strip()
sys.path.insert(0,'/home/user/ai-commerce-os/tools/video')
S = {"stability": 0.5, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": True, "speed": 1.03}
body = {"text": TEXT, "model_id": "eleven_multilingual_v2", "voice_settings": S, "seed": seed}
req = urllib.request.Request("https://api.elevenlabs.io/v1/text-to-speech/qpN0R0fY4KogCCNqGYDR/with-timestamps?output_format=mp3_44100_128",
    data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "xi-api-key": os.environ.get("ELEVENLABS_API_KEY", "dummy")})
d = json.load(urllib.request.urlopen(req, timeout=180))
open(out + ".mp3", "wb").write(base64.b64decode(d["audio_base64"]))
json.dump(d["alignment"], open(out + ".json", "w"), ensure_ascii=False)
print(out, round(d["alignment"]["character_end_times_seconds"][-1], 2))
