import json, subprocess, sys, uuid, urllib.request, os
f = sys.argv[1]
b = uuid.uuid4().hex
def part(n, v): return f'--{b}\r\nContent-Disposition: form-data; name="{n}"\r\n\r\n{v}\r\n'.encode()
data = part('model_id','scribe_v1') + part('language_code','rus') + part('timestamps_granularity','word') + \
  f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n'.encode() + open(f,'rb').read() + f'\r\n--{b}--\r\n'.encode()
req = urllib.request.Request("https://api.elevenlabs.io/v1/speech-to-text", data=data, headers={"Content-Type": f"multipart/form-data; boundary={b}", "xi-api-key": os.environ.get("ELEVENLABS_API_KEY","dummy")})
d = json.load(urllib.request.urlopen(req, timeout=180))
json.dump(d, open(f + ".stt.json", "w"), ensure_ascii=False)
print(d["text"])
