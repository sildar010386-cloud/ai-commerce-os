#!/usr/bin/env python3
"""Build two printable PDFs (selling hooks+scripts, reach hooks+scripts) for 2026-11-01.

Same look as top5_2026-10-31.html: landscape A4, one table, repeated thead,
one reel per page. Rendered with headless Chrome.
"""
import html
import json
import re
import subprocess
from pathlib import Path

BASE = Path("/home/user/ai-commerce-os/content/reels")
SC = BASE / "scripts"
CHROME = next(Path("/opt/pw-browsers").glob("chromium*/chrome-linux64/chrome"))
FONTS = "file:///home/user/ai-commerce-os/tools/tiktok/fonts"

CSS = f"""
@font-face{{font-family:M;src:url({FONTS}/montserrat-cyrillic-400-normal.woff2);font-weight:400}}
@font-face{{font-family:M;src:url({FONTS}/montserrat-cyrillic-800-normal.woff2);font-weight:800}}
@page{{size:A4 landscape;margin:10mm}} body{{font-family:M,sans-serif;font-size:9.5pt;color:#1b1b1b}}
h1{{font-size:17pt;margin:0 0 4px}} p.sub{{font-size:9pt;color:#555;margin:0 0 8px}}
table{{border-collapse:collapse;width:100%}}
th,td{{border:1px solid #bbb;padding:5px 6px;vertical-align:top}} th{{background:#ffe3ef;text-align:left}}
td.n{{white-space:nowrap;font-weight:800}} td.new{{background:#fff4e6}} .s{{font-size:8pt;color:#555}}
td.t{{width:42%;font-size:9.5pt;line-height:1.35}} tr{{page-break-inside:avoid}}
td.o{{width:24%}} td.h{{width:24%}}
"""

HOOK_RE = re.compile(r"^(Если|Почему|Как)\b", re.I)


def esc(s):
    return html.escape(s, quote=False)


def para(text):
    return "<br><br>".join(esc(p) for p in text.split("\n\n"))


def mark(text):
    """Escape and bold the leading если/почему/как."""
    m = HOOK_RE.match(text)
    if not m:
        return esc(text)
    return f"<b>{esc(m.group(0))}</b>" + esc(text[m.end():])


# ---------- cleaning for SELLING scripts ----------
DROP = re.compile(r"ИП|трек|post\.kz|квитанц|юрлиц|предоплат|WhatsApp|не страшно|боитесь заказывать"
                  r"|По заказу всё прозрачно|Посылку можно отследить")
CTA_OLD = re.compile(r"пришл[её]м ссылку на WhatsApp\.")
CTA_NEW = "менеджер свяжется с вами и всё расскажет."


def clean_scene(v):
    v = CTA_OLD.sub(CTA_NEW, v)
    sents = re.split(r"(?<=[.!?…])\s+", v.strip())
    return " ".join(s for s in sents if not DROP.search(s))


def selling_text(scenes, new_hook=None):
    out = []
    for i, sc in enumerate(scenes):
        v = new_hook if (i == 0 and new_hook) else sc["voice"]
        v = clean_scene(v)
        if v:
            out.append(v)
    return "\n\n".join(out)


def parse_source(src):
    q = re.search(r"(«.*»)[^«»]*?,\s*([\d ]+) просмотров", src)
    quote, views = q.group(1), q.group(2).strip()
    url = re.search(r"https?://\S+", src).group(0).rstrip(".,;)")
    m = re.search(r"tiktok\.com/(@[\w.]+)", url)
    if m:
        acc = "TikTok " + m.group(1)
    else:
        acc = "Instagram @" + re.search(r"instagram\.com/([\w.]+)/", url).group(1)
    return quote, views, acc


# new hooks for SELLING (first scene voice), applied where the word keeps the meaning
SELL_HOOKS = {
    "S03": "Почему после десяти лет брака меня понимает только тёща? Этот отпариватель мне подарила тоже она.",
    "S04": "Как сейчас гладят, такого ни у кого не увидишь: без доски.",
    "S05": "Если вы собираетесь нести рубашки в химчистку, сначала посмотрите, что я увидел.",
    "S07": "Как гладить без доски? Мало кто знает: прижал, как утюг, или повёл паром.",
    "S11": "Если вы зимой ходите в мятом пуховике, потому что утюгом его гладить страшно, попробуйте вот так.",
    "S16": "Если рубашка нужна через пять минут, а доска стоит в другой комнате, это поймут только мужчины.",
    "S17": "Если вы купили утюг с доской, кажется, я сейчас вас расстрою: есть отпариватель два в одном, и он греется девять секунд.",
    "S18": "Если не веришь рекламе, и правильно. Поэтому засекаю: греется девять секунд.",
}


def build_selling():
    allj = json.load(open(SC / "scripts_2026-10-27.json"))
    top5 = {x["id"].split("(")[1][:-1]: x for x in json.load(open(SC / "top5_2026-10-31.json"))}
    items = sorted((s for s in allj if s["type"] == "selling"), key=lambda s: s["id"])
    rows, n_hook, changed = [], 0, []
    for s in items:
        sid = s["id"]
        s = top5.get(sid, s)  # already-updated versions (S01, S02, S06, S14, S15)
        quote, views, acc = parse_source(s["source"])
        hook = s["scenes"][0]["voice"]
        new = False
        if sid in SELL_HOOKS:
            hook, new = SELL_HOOKS[sid], True
            changed.append(sid)
        text = selling_text(s["scenes"], hook if new else None)
        if HOOK_RE.match(hook):
            n_hook += 1
        num = sid + ("<br><span class=s>вышел 01.11</span>" if sid == "S14" else "")
        rows.append(
            f"<tr><td class=n>{num}</td>"
            f"<td class=o>{esc(quote)}<br><span class=s>{esc(views)} просмотров · {esc(acc)}</span></td>"
            f"<td class=\"h{' new' if new else ''}\">{mark(hook)}</td>"
            f"<td class=t>{para(text)}</td></tr>")
    return rows, n_hook, len(items), changed, "Bikas · Продающие ролики: хуки и сценарии (01.11)"


# ---------- REACH ----------
# (title, first) overrides for the 17 hook rows, by index
REACH_HOOKS = {
    0: ("КАК ОБМАНЫВАЮТ НА ПРЕДОПЛАТЕ?",
        "Как обманывают на предоплате? Прикиньте, сейчас жёсткое видео покажу, прям жёсткое, жесть. Обалдеете."),
    1: ("ЕСЛИ ПЛАТИЛИ ПРЕДОПЛАТУ: ЭТО ЧТО ТАКОЕ?",
        "Если вы хоть раз платили предоплату, смотрите до конца. Прикиньте, сейчас жёсткое видео покажу, прям жёсткое, жесть. Обалдеете."),
    2: ("КАК ПРОДАВЕЦ ПРОВЕРЯЕТ ВОЗВРАТЫ",
        "Как мы проверяем возвраты? Очень часто приходят вот такие вот возвраты. Это человек попользовался или не попользовался, мы определить не можем. Сейчас мы будем его вскрывать и посмотрим."),
    5: ("ЕСЛИ У МЕНЯ ЕСТЬ 14 ДНЕЙ, ЗНАЧИТ МАГАЗИН ОБЯЗАН ВЕРНУТЬ ДЕНЬГИ?", None),
    6: ("ЕСЛИ ЭТО ВЕСЬ БРАК ЗА 2 ДНЯ, В КАКУЮ КОРОБКУ ЕГО ПОЛОЖИТЬ?",
        "Если это весь брак за два дня, то в какую же коробку его положить?"),
    11: ("КАК ВЫГЛЯДИТ ИНТЕРНЕТ-МАГАЗИН ГЛАЗАМИ КЛИЕНТА:", None),
    12: ("КАК МЫ ОТВЕЧАЕМ КЛИЕНТУ, который обнаружил брак в посылке?",
         "Как мы отвечаем клиенту, который обнаружил брак в посылке? А я говорил проверять на почте!"),
    13: ("ЕСЛИ ВЫ ГЛАДИТЕ УТЮГОМ, ВАМ ОБ ЭТОМ НИКТО НЕ СКАЖЕТ",
         "Если вы гладите утюгом, вам об этом никто не скажет, но я вам это скажу: …"),
}
# hook row index -> reach script id (source names the same ref)
HOOK_TO_SCRIPT = {0: "R5", 1: "R2", 3: "R7", 7: "R6"}
# extra rows: original reference text (from the script's "source")
EXTRA_ORIG = {
    "R1": ("«Это что такое?»: «Прикиньте, сейчас жёсткое видео покажу, прям жёсткое, жесть. Обалдеете.» (форма)",
           "880 600 просмотров · TikTok @bopetay.kz (r01)"),
    "R3": ("«КАК СОТРУДНИК ИЩЕТ ТОВАР: → КАК ОН ДОЛЖЕН ЕГО ИСКАТЬ:» (текст на экране, речи нет; форма)",
           "468 600 просмотров · TikTok @egor_egregor (r07)"),
    "R4": ("«КАК СОТРУДНИК ИЩЕТ ТОВАР: → КАК ОН ДОЛЖЕН ЕГО ИСКАТЬ:» (форма чек-лист «как должно быть»)",
           "468 600 просмотров · TikTok @egor_egregor (r07)"),
    "R8": ("«Почему полы в отелях чище, чем дома / Даже когда их моют реже» (форма)",
           "431 500 просмотров · TikTok @cleanpolya.co"),
}


def build_reach():
    hooks = json.load(open(BASE / "hooks" / "hooks_2026-10-27_v3.json"))
    allj = json.load(open(SC / "scripts_2026-10-27.json"))
    reach = {s["id"]: s for s in allj if s["type"] == "reach"}
    used = set(HOOK_TO_SCRIPT.values())
    rows, n_hook, total, changed = [], 0, 0, []
    for i, h in enumerate(hooks):
        title, first = h["title"], h["first"]
        new = False
        if i in REACH_HOOKS:
            t2, f2 = REACH_HOOKS[i]
            new = True
            title = t2
            first = f2 if f2 else first
            changed.append(f"№{i+1}")
        # original cell
        o = ""
        if h["orig_title"] != "(нет)":
            o += f"«{esc(h['orig_title'])}»<br>"
        o += esc(h["orig_first"] if h["orig_first"].startswith("(") else "«" + h["orig_first"] + "»")
        o += f"<br><span class=s>{esc(h['views'])} просмотров · TikTok {esc(h['author'])} ({esc(h['ref'])})</span>"
        # hook cell
        if title.startswith("(нет, как в оригинале)"):
            hc = "<span class=s>заголовок: как в оригинале</span>"
            head_for_count = first
        else:
            hc = mark(title)
            head_for_count = title
        hc += "<br><span class=s>говорит:</span> " + esc(first)
        if HOOK_RE.match(head_for_count):
            n_hook += 1
        sid = HOOK_TO_SCRIPT.get(i)
        if sid:
            text = "\n\n".join(sc["voice"] for sc in reach[sid]["scenes"])
            body = para(text)
            num = f"№{i+1}<br><span class=s>сценарий {sid}</span>"
        else:
            body = "Сценария пока нет"
            if h["need"]:
                body += "<br><br><b>Нужно от вас:</b> " + esc(h["need"])
            num = f"№{i+1}"
        rows.append(
            f"<tr><td class=n>{num}</td><td class=o>{o}</td>"
            f"<td class=\"h{' new' if new else ''}\">{hc}</td><td class=t>{body}</td></tr>")
        total += 1
    # extra rows: reach scripts that matched no hook row
    for sid in sorted(set(reach) - used):
        s = reach[sid]
        o_txt, o_meta = EXTRA_ORIG[sid]
        hook = s["scenes"][0]["voice"]
        if HOOK_RE.match(hook):
            n_hook += 1
        text = "\n\n".join(sc["voice"] for sc in s["scenes"])
        rows.append(
            f"<tr><td class=n>доп.<br><span class=s>сценарий {sid}</span></td>"
            f"<td class=o>{esc(o_txt)}<br><span class=s>{esc(o_meta)}</span></td>"
            f"<td class=h>{mark(hook)}</td><td class=t>{para(text)}</td></tr>")
        total += 1
    return rows, n_hook, total, changed, "Bikas · Охватные ролики: хуки и сценарии (01.11)"


def write(name, built):
    rows, n, total, changed, title = built
    sub = (f"С «если / почему / как» — {n} из {total}. "
           f"Изменённые хуки выделены цветом: {len(changed)}.")
    doc = (f"<!doctype html><html><head><meta charset=utf-8><style>{CSS}</style></head><body>"
           f"<h1>{title}</h1><p class=sub>{sub}</p><table><thead><tr><th>№</th>"
           f"<th>оригинал (дословно) + просмотры + аккаунт</th><th>наш хук</th><th>текст сценария</th></tr></thead>"
           + "".join(rows) + "</table></body></html>")
    h = SC / f"{name}.html"
    h.write_text(doc, encoding="utf-8")
    subprocess.run([str(CHROME), "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                    f"--print-to-pdf={SC / (name + '.pdf')}", f"file://{h}"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(name, "rows", total, "hooks", n, "changed", changed)


if __name__ == "__main__":
    write("prodayushchie_2026-11-01", build_selling())
    write("ohvatnye_2026-11-01", build_reach())
