"""Automatic replies to every new comment under our Threads posts (owner 2026-10-26), without Claude.

  python3 tools/threads/autoreply.py            reply to new comments (after funnel.py has handled trigger words)
  python3 tools/threads/autoreply.py --dry-run  only print what would be answered

Rules first, AI second (docs/ARCHITECTURE_V1.md: code before LLM):
- trigger word («пар») -> left to funnel.py;
- buying intent (цена, где купить, хочу такой, ...) -> fixed reply with the WhatsApp link, 🔥 to the bot, CRM lead;
- empty comment (sticker/photo) -> a short emoji reply;
- anything else -> a short friendly reply written by the free Workers AI model through the CRM (/api/hooks/reply);
  the model may answer SKIP (rude, spam, unclear) and its text is checked (no links, prices, @mentions, ≤ 300 chars).
Runs on GitHub Actions with funnel.yml every 15 minutes. Settings: content/funnel/settings.json.
"""
import json, os, re, subprocess, sys, time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
sys.path.insert(0, os.path.abspath(ROOT))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tools.crm.client import post as crm_post  # noqa: E402
from funnel import CFG, is_keyword  # noqa: E402
from replies import reply, unanswered  # noqa: E402

INTENT = re.compile(r"цен|сколько стоит|почем|почём|где купить|как купить|как заказать|заказ|хочу такой|хочу такую|"
                    r"где взять|ссылк|доставк|каспи|kaspi|в наличии|продаете|продаёте", re.I)
BAD = re.compile(r"https?://|www\.|wa\.me|@|₸|тенге|тг\b|руб|\$|\d{3,}", re.I)
SYSTEM = """Ты отвечаешь на комментарии в Threads от имени магазина товаров для дома Bikas (Казахстан, аккаунт @bikas.home).
Пиши по-русски, дружелюбно и коротко: 1–2 предложения, можно 1 эмодзи, иногда лёгкий вопрос в ответ.
Отвечай только про ЭТОТ комментарий: откликнись на конкретную деталь, которую человек написал (что назвал, рассказал или спросил). Ничего не додумывай и не упоминай того, чего нет в комментарии.
Если комментарий из 1–3 слов или цифра — ответь коротко и тепло, без вопросов про то, чего человек не писал. Ты магазин: не выдумывай личный опыт («я купила», «мой муж»), не называй цен, не давай ссылок,
не упоминай другие магазины и маркетплейсы, не обещай того, чего не знаешь. Про наш товар (ручной отпариватель) говори, только если
спрашивают про глажку, и только эти факты: греется за 9 секунд, 2 в 1 (утюг и отпариватель), без гладильной доски, маленькая коробка,
бесплатная доставка Казпочтой по Казахстану.
Если комментарий грубый, спам, реклама, политика, не на русском языке или непонятен — ответь одним словом SKIP.
Выведи только текст ответа, без кавычек."""
MAX_PER_RUN = 10


def ai_reply(post, comment):
    r = crm_post("/api/hooks/reply", {"system": SYSTEM, "post": post, "comment": comment})
    text = ((r or {}).get("reply") or "").strip().strip('"«»')
    if not text or text.upper().startswith("SKIP") or BAD.search(text) or len(text) > 300:
        return None
    return text


def tg(text):
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "telegram", "tg.py"), "send", text])


def main(dry):
    wa = f"wa.me/{CFG['whatsapp']}"
    done = 0
    for c in unanswered(CFG["lookback_posts"]):
        if done >= MAX_PER_RUN:
            break
        text = (c.get("text") or "").strip()
        if is_keyword(text):
            continue  # funnel.py answers trigger words with the WhatsApp link
        lead = bool(INTENT.search(text))
        if lead:
            answer = f"Спасибо за интерес! 🙌 Всё расскажем в WhatsApp, просто нажмите на ссылку: {wa}"
        elif not text:
            answer = "🙌"
        else:
            answer = ai_reply(c.get("post", ""), text)
        print(json.dumps(c, ensure_ascii=False), "->", answer)
        if dry or not answer:
            continue
        reply(c["id"], answer)
        done += 1
        if lead:
            crm_post("/api/hooks/lead", {"source": "Threads", "user": c["user"], "text": text, "permalink": c["permalink"]})
            tg(f"🔥 Threads: @{c['user']} спросил «{text}» под постом «{c['post']}».\n"
               f"Ответили ссылкой на WhatsApp (+{CFG['whatsapp']}) — ждите сообщения.\n{c['permalink']}")
        time.sleep(15)  # a burst of replies looks like spam to Threads
    print(f"{done} replied")


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
