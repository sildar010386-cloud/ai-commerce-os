import asyncio
import logging

import aiohttp
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.enums import ParseMode
from aiogram.types import BotCommand

from app.bot.handlers import build_router
from app.bot.summary import SummaryBatcher
from app.config import Settings, get_settings
from app.db import init_db, make_engine, make_sessionmaker

log = logging.getLogger(__name__)

COMMANDS = [
    BotCommand(command="product", description="Выбрать активный товар"),
    BotCommand(command="newproduct", description="Добавить товар"),
    BotCommand(command="library", description="Библиотека сырья"),
    BotCommand(command="help", description="Как пользоваться"),
]


async def ensure_logged_out_from_cloud(settings: Settings) -> None:
    """A bot must log out of the cloud Bot API once before a local Bot API server can serve it."""
    marker = settings.state_dir / "cloud_logged_out"
    if marker.exists():
        return
    url = f"https://api.telegram.org/bot{settings.bot_token}/logOut"
    async with aiohttp.ClientSession() as http:
        async with http.post(url) as response:
            payload = await response.json(content_type=None)
    # "Logged out" as an error means it was already done earlier.
    if payload.get("ok") or "Logged out" in str(payload.get("description", "")):
        settings.state_dir.mkdir(parents=True, exist_ok=True)
        marker.write_text("ok\n")
        log.info("Bot logged out from the cloud Bot API; using the local server from now on")
    else:
        raise RuntimeError(f"Cloud logOut failed: {payload.get('description')}")


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if not settings.allowed_user_ids:
        log.warning("ALLOWED_USER_IDS is empty: the bot will only reply with the sender's ID")

    settings.media_dir.mkdir(parents=True, exist_ok=True)
    engine = make_engine(settings.database_url)
    sessionmaker = make_sessionmaker(engine)
    await init_db(engine, sessionmaker)

    session = None
    if settings.bot_api_url:
        if settings.bot_api_local:
            await ensure_logged_out_from_cloud(settings)
        server = TelegramAPIServer.from_base(settings.bot_api_url, is_local=settings.bot_api_local)
        session = AiohttpSession(api=server)
    bot = Bot(settings.bot_token, session=session, default=DefaultBotProperties(parse_mode=ParseMode.HTML))

    batcher = SummaryBatcher(settings.summary_delay_s, lambda chat_id, text: bot.send_message(chat_id, text))
    dispatcher = Dispatcher()
    dispatcher.include_router(build_router(settings, sessionmaker, batcher))

    await bot.set_my_commands(COMMANDS)
    log.info("Bot started")
    try:
        await dispatcher.start_polling(bot)
    finally:
        await bot.session.close()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
