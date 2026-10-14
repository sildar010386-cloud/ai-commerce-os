#!/bin/bash
# Download reference reels and prepare them for analysis (docs/REF_SEARCH.md).
#   tools/refs/fetch.sh LINKS.txt OUTDIR     LINKS.txt: "ID URL" per line
# Output in OUTDIR: ID.mp4 + ID.info.json (views, likes, description), stt/ID.json (speech with word times,
# ElevenLabs scribe_v1), sheet*.jpg (per video: frames 0-3 s every 0.5 s + 6 points across the reel).
# TikTok needs --impersonate chrome; YouTube blocks downloads without login; Instagram works.
set -u
LINKS=$1; OUT=$2; mkdir -p "$OUT/stt" "$OUT/fr"; cd "$OUT"
while read -r id url; do
  [ -z "$id" ] && continue; [ -s "$id.mp4" ] && continue
  timeout 150 yt-dlp -q --no-warnings --impersonate chrome -f "best[height<=1080]/best" --write-info-json -o "$id.%(ext)s" "$url" >/dev/null 2>&1 || echo "FAIL $id $url"
done < "$LINKS"
for f in *.mp4; do
  i=${f%.mp4}
  if [ ! -s stt/$i.json ]; then
    ffmpeg -y -loglevel error -i "$f" -vn -ac 1 -ar 16000 -b:a 48k stt/$i.mp3 && \
    curl -sS https://api.elevenlabs.io/v1/speech-to-text -H "xi-api-key: ${ELEVENLABS_API_KEY:-}" -F model_id=scribe_v1 \
      -F file=@stt/$i.mp3 -F timestamps_granularity=word > stt/$i.json &
  fi
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f"); n=0
  for t in 0 0.5 1 1.5 2 3 $(python3 -c "d=$dur;print(' '.join(str(round(3+(d-3.3)*k/6,1)) for k in range(1,7)))"); do
    n=$((n+1)); ffmpeg -loglevel error -y -ss $t -i "$f" -frames:v 1 -vf "scale=120:213,drawtext=text='$t':fontcolor=yellow:fontsize=14:x=3:y=3:box=1:boxcolor=black" fr/${i}_$(printf %02d $n).jpg
  done
done
wait
python3 -I - "$OUT" <<'PY'
import glob, os, sys, json
from PIL import Image, ImageDraw
d=sys.argv[1]; ids=sorted({os.path.basename(f).split('_')[0] for f in glob.glob(d+'/fr/*.jpg')})
rows=[]
for i in ids:
    fs=sorted(glob.glob(f"{d}/fr/{i}_*.jpg")); row=Image.new('RGB',(50+120*len(fs),213),'white')
    ImageDraw.Draw(row).text((4,95),i,fill='black')
    for k,f in enumerate(fs): row.paste(Image.open(f).resize((120,213)),(50+120*k,0))
    rows.append(row)
for g in range(0,len(rows),4):
    part=rows[g:g+4]; im=Image.new('RGB',(max(r.width for r in part),213*len(part)),'white')
    for k,r in enumerate(part): im.paste(r,(0,213*k))
    im.save(f"{d}/sheet{g//4+1}.jpg",quality=85); print(f"sheet{g//4+1}", ids[g:g+4])
for f in sorted(glob.glob(d+"/*.info.json")):
    m=json.load(open(f)); i=os.path.basename(f).split('.')[0]
    s=d+f"/stt/{i}.json"; t=json.load(open(s)).get("text","") if os.path.exists(s) else ""
    print(f"{i} | {m.get('duration')}s | views {m.get('view_count')} | likes {m.get('like_count')} | comm {m.get('comment_count')} | {t[:200]}")
PY
