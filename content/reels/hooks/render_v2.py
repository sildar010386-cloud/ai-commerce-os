"""Printable PDF: original hook -> our hook copied at 80-90 %, with если/почему/как first.
Words of ours that are not in the original are highlighted; '% слов оригинала' = share of the original's
first-phrase words kept in ours.
  python3 content/reels/hooks/render_v2.py content/reels/hooks/hooks_2026-10-27_v2.json "Заголовок"
"""
import glob, html, json, os, re, subprocess, sys

src, title = sys.argv[1], sys.argv[2]
F = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools", "tiktok", "fonts")
e = html.escape
norm = lambda w: re.sub(r"[^а-яёa-z0-9]", "", w.lower()).replace("ё", "е")


def mark(ours, orig):
    have = {norm(w) for w in orig.split()}
    return " ".join(e(w) if norm(w) in have or not norm(w) else f"<span class=new>{e(w)}</span>" for w in ours.split())


def kept(ours, orig):
    o = [norm(w) for w in orig.split() if norm(w)]
    have = {norm(w) for w in ours.split()}
    return round(100 * sum(w in have for w in o) / len(o)) if o else 0


rows = ""
for n, h in enumerate(json.load(open(src)), 1):
    need = f"<p class=need>⚠ {e(h['need'])}</p>" if h.get("need") else ""
    st = "" if "strong" not in h else ("<p class=st>Хук сильный — не трогаем</p>" if h["strong"] else "<p class=wk>Хук слабый — усиливаем «если / почему / как»</p>")
    rows += (f"<tr><td class=n>{n}</td><td class=o><b>{e(h['ref'])} · {e(h['author'])}</b> <span class=v>{e(h['views'])}</span>"
             f"<p class=ot>{e(h['orig_title'])}</p><p>{e(h['orig_first'])}</p>{st}</td>"
             f"<td class=t>{mark(h['title'], h['orig_title'] + ' ' + h['orig_first'])}</td>"
             f"<td>{mark(h['first'], h['orig_first'] + ' ' + h['orig_title'])}{need}</td>"
             f"<td class=n>{kept(h['first'], h['orig_first'])}%</td><td class=ok>☐</td></tr>")
doc = f"""<!doctype html><html><head><meta charset=utf-8><style>
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-400-normal.woff2);font-weight:400}}
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-800-normal.woff2);font-weight:800}}
@page{{size:A4 landscape;margin:10mm}} body{{font-family:M,sans-serif;font-size:9.5pt;color:#1b1b1b}}
h1{{font-size:17pt;margin:0 0 4px}} p{{margin:3px 0}} .crit{{margin:0 0 8px;color:#333}}
table{{border-collapse:collapse;width:100%}} th,td{{border:1px solid #bbb;padding:4px 6px;vertical-align:top}}
th{{background:#ffe3ef;text-align:left}} tr{{page-break-inside:avoid}} td.n{{font-weight:800;text-align:center;white-space:nowrap}}
td.o{{width:30%;background:#fafafa}} .v{{color:#c2185b;font-weight:800}} .ot{{font-weight:800}}
td.t{{width:21%;font-weight:800;font-size:10.5pt}} td.ok{{width:4%;text-align:center;font-size:14pt}}
.new{{background:#ffd9c2;color:#b8430a}} .st{{color:#1b7f3b;font-weight:800}} .wk{{color:#b8430a;font-weight:800}} .need{{color:#b45309;font-size:8.5pt}}
</style></head><body><h1>{e(title)}</h1>
<p class=crit>Правило: сильный хук залетевшего ролика идёт первым, слово в слово; наш текст — после него. «Если / почему / как» — только там, где хук оригинала слабый.
<span class=new>Выделено</span> — слова, которых нет в оригинале. «%» — сколько слов первой фразы оригинала осталось. Оценку ставите вы. «⚠» — что нужно от вас.</p>
<table><tr><th>№</th><th>Оригинал: заголовок и первые слова</th><th>Наш заголовок на экране</th><th>Наши первые слова</th><th>% слов</th><th>Берём</th></tr>{rows}</table>
</body></html>"""
out_html = src.rsplit(".", 1)[0] + ".html"
open(out_html, "w").write(doc)
chrome = glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome")[0]
pdf = src.rsplit(".", 1)[0] + ".pdf"
subprocess.run([chrome, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                f"--print-to-pdf={pdf}", "file://" + os.path.abspath(out_html)], check=True, capture_output=True)
print(pdf)
