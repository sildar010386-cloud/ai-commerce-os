"""Printable PDF of reel scripts from a scripts JSON (content/reels/scripts/scripts_<date>.json).
  python3 content/reels/scripts/render_pdf.py content/reels/scripts/scripts_2026-10-27.json "Заголовок" [notes.html]
"""
import glob, html, json, os, subprocess, sys

src, title = sys.argv[1], sys.argv[2]
notes = open(sys.argv[3]).read() if len(sys.argv) > 3 else ""
F = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools", "tiktok", "fonts")
e = html.escape
items = json.load(open(src))
kinds = {"reach": "Охватный", "selling": "Продающий"}
toc = "".join(f"<tr><td class=n>{e(s['id'])}</td><td>{kinds.get(s['type'], s['type'])}</td><td><b>{e(s['title'])}</b></td>"
              f"<td class=n>~{s.get('length_s', '')} с</td><td class=s>{e(s.get('source', ''))}</td>"
              f"<td>{e(s.get('needs_footage') or '—')}</td></tr>" for s in items)
body = ""
for s in items:
    rows = "".join(f"<tr><td class=n>{e(c['s'])}</td><td><b>{e(c['block'])}</b></td><td>{e(c['bg'])}</td>"
                   f"<td>{e(c['text'])}</td><td>{e(c['voice'])}</td></tr>" for c in s["scenes"])
    need = f"<p class=warn>Нужна съёмка: {e(s['needs_footage'])}</p>" if s.get("needs_footage") else ""
    body += (f"<section><h2>{e(s['id'])} · {kinds.get(s['type'], '')} · {e(s['title'])}</h2>"
             f"<p class=meta>Основа: {e(s.get('source', ''))}. Длительность ~{s.get('length_s', '')} с.</p>{need}"
             f"<table class=sc><tr><th>сек</th><th>блок</th><th>фон</th><th>текст на экране</th><th>что вы говорите</th></tr>{rows}</table></section>")
doc = f"""<!doctype html><html><head><meta charset=utf-8><style>
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-400-normal.woff2);font-weight:400}}
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-800-normal.woff2);font-weight:800}}
@page{{size:A4 landscape;margin:11mm}} body{{font-family:M,sans-serif;font-size:10pt;color:#1b1b1b}}
h1{{font-size:19pt;margin:0 0 4px}} h2{{font-size:13pt;margin:12px 0 3px;color:#c2185b}}
.meta{{color:#555;margin:1px 0 5px}} .warn{{color:#b45309;font-weight:800;margin:2px 0 5px}}
table{{border-collapse:collapse;width:100%;margin-bottom:6px}} th,td{{border:1px solid #bbb;padding:4px 5px;vertical-align:top}}
th{{background:#ffe3ef;text-align:left}} td.n{{white-space:nowrap;font-weight:800}} td.s{{font-size:8pt}}
section{{page-break-inside:avoid}} .break{{page-break-before:always}} ul{{margin:3px 0 0 18px;padding:0}}
</style></head><body><h1>{e(title)}</h1>{notes}
<h2>Все сценарии</h2><table><tr><th>№</th><th>тип</th><th>заголовок на экране</th><th>длина</th><th>основа</th><th>нужна съёмка</th></tr>{toc}</table>
<div class=break></div>{body}</body></html>"""
out_html = src.rsplit(".", 1)[0] + ".html"
open(out_html, "w").write(doc)
chrome = (glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome") + glob.glob("/opt/pw-browsers/chromium*/chrome-linux64/chrome") + glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"))[0]
pdf = src.rsplit(".", 1)[0] + ".pdf"
subprocess.run([chrome, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                f"--print-to-pdf={pdf}", "file://" + os.path.abspath(out_html)], check=True, capture_output=True)
print(pdf)
