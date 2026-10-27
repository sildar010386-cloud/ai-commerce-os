"""Printable PDF of reach hooks: original reel -> our on-screen title and first words, with a self-score.
  python3 content/reels/hooks/render_pdf.py content/reels/hooks/hooks_2026-10-27.json "Заголовок"
"""
import glob, html, json, os, subprocess, sys

src, title = sys.argv[1], sys.argv[2]
F = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools", "tiktok", "fonts")
e = html.escape
rows = ""
for r in json.load(open(src)):
    n = len(r["hooks"])
    for i, h in enumerate(r["hooks"]):
        orig = ""
        if i == 0:
            old = f"<p class=old>Было: {e(r['old'])}</p>" if r.get("old") else ""
            orig = (f"<td rowspan={n} class=o><b>{e(r['ref'])} · {e(r['author'])}</b><br><span class=v>{e(r['views'])} просмотров</span>"
                    f"<p><b>Заголовок:</b> {e(r['orig_title'])}</p><p><b>Первые слова:</b> {e(r['orig_first'])}</p>"
                    f"<p class=why>Почему залетел: {e(r['why'])}</p>{old}</td>")
        need = f"<p class=need>⚠ {e(h['need'])}</p>" if h.get("need") else ""
        rows += (f"<tr>{orig}<td class=t>{e(h['title'])}</td><td>{e(h['first'])}{need}</td>"
                 f"<td class=s>{h['score']}/10</td><td class=ok>☐</td></tr>")
doc = f"""<!doctype html><html><head><meta charset=utf-8><style>
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-400-normal.woff2);font-weight:400}}
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-800-normal.woff2);font-weight:800}}
@page{{size:A4 landscape;margin:10mm}} body{{font-family:M,sans-serif;font-size:9.5pt;color:#1b1b1b}}
h1{{font-size:17pt;margin:0 0 4px}} p{{margin:3px 0}} .crit{{margin:0 0 8px;color:#333}}
table{{border-collapse:collapse;width:100%}} th,td{{border:1px solid #bbb;padding:4px 6px;vertical-align:top}}
th{{background:#ffe3ef;text-align:left}} tr{{page-break-inside:avoid}}
td.o{{width:30%;background:#fafafa}} .v{{color:#c2185b;font-weight:800}} .why{{color:#444;font-style:italic}}
.old{{color:#888}} td.t{{width:20%;font-weight:800;font-size:11pt;color:#F26B1E}} td.s{{font-weight:800;white-space:nowrap;text-align:center}}
td.ok{{width:4%;text-align:center;font-size:14pt}} .need{{color:#b45309;font-size:8.5pt}}
</style></head><body><h1>{e(title)}</h1>
<p class=crit>Оценка — по 5 признакам, по 2 балла: 1) понятно из сетки профиля за секунду; 2) «если / почему / как» или вопрос;
3) угроза или выгода лично для зрителя (деньги, обман, испорченная вещь); 4) интрига — ответ только в конце; 5) конкретика (цифра, предмет, ситуация).
Ниже 8 — не беру. «⚠» — что нужно от вас или что я проверю до сценария. В последнем столбце отметьте, какие хуки берём.</p>
<table><tr><th>Оригинал</th><th>Наш заголовок на экране</th><th>Первые слова ведущего (повтор заголовка + интрига)</th><th>Оценка</th><th>Берём</th></tr>{rows}</table>
</body></html>"""
out_html = src.rsplit(".", 1)[0] + ".html"
open(out_html, "w").write(doc)
chrome = glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome")[0]
pdf = src.rsplit(".", 1)[0] + ".pdf"
subprocess.run([chrome, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                f"--print-to-pdf={pdf}", "file://" + os.path.abspath(out_html)], check=True, capture_output=True)
print(pdf)
