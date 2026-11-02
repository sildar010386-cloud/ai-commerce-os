// Cloudflare Worker: Telegram webhook -> GitHub repository_dispatch (event "spy-search").
// Code supplied by the bikas-target session (02.11.2026); no secrets here.
const HELP = [
  "🤖 Ildar Food Bot 2.0 — разведка товарки (Казахстан)",
  "",
  "Что можно прислать:",
  "• слово или фраза — реклама Instagram/Facebook в Казахстане, например: массажёр для шеи",
  "• фраза + «снг» — реклама Instagram/Facebook в СНГ, например: массажёр для шеи снг",
  "• «тикток» + фраза — залетевшие видео TikTok в Казахстане, например: тикток массажёр",
  "• ссылка на видео TikTok — пришлю видео без водяного знака",
  "• номера объявлений (через запятую) — пришлю видео этих объявлений",
  "• /start или «помощь» — эта справка",
  "",
  "Большую разведку рынка (топ товаров) запускает Claude по вашей просьбе. Ответ на запрос приходит примерно через минуту.",
].join("\n");
const MAX_QUERY = 500;
const HELP_WORDS = new Set(["/start", "/help", "помощь", "help", "справка", "start"]);
async function tgSend(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return res.ok;
}
async function dispatch(env, query, chatId) {
  return fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "ildar-spy-bot",
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: "spy-search", client_payload: { query, chat_id: String(chatId) } }),
  });
}
export async function handleUpdate(update, env) {
  const msg = update && update.message;
  if (!msg || !msg.chat || typeof msg.text !== "string") return;
  if (String(msg.chat.id) !== String(env.OWNER_CHAT_ID)) return;
  const text = msg.text.trim();
  if (!text) return;
  const chatId = msg.chat.id;
  const low = text.toLowerCase();
  if (HELP_WORDS.has(low) || low.startsWith("/start") || low.startsWith("/help")) {
    await tgSend(env, chatId, HELP); return;
  }
  const query = text.slice(0, MAX_QUERY);
  const shown = query.length > 100 ? query.slice(0, 100) + "…" : query;
  await tgSend(env, chatId, `🔎 Принял: «${shown}». Ответ придёт через ~1 минуту.`);
  try {
    const res = await dispatch(env, query, chatId);
    if (res.status !== 204) {
      const body = (await res.text()).slice(0, 200);
      await tgSend(env, chatId, `⚠️ Не удалось запустить поиск: GitHub ответил ${res.status}. ${body}`);
    }
  } catch (e) {
    await tgSend(env, chatId, `⚠️ Не удалось запустить поиск: ${e && e.message ? e.message : e}`);
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("ok");
    if (request.method === "POST" && url.pathname === "/tg") {
      try {
        if (env.TG_WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.TG_WEBHOOK_SECRET) {
          await handleUpdate(await request.json(), env);
        }
      } catch (e) { console.error("handler error", e); }
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
};
