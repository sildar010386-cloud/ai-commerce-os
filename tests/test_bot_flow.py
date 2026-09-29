"""End-to-end handler flow with a fake Telegram session (no network)."""

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aiogram import Bot, Dispatcher
from aiogram.client.session.base import BaseSession
from aiogram.methods import AnswerCallbackQuery, EditMessageText, GetFile, SendMessage, TelegramMethod
from aiogram.types import Chat, File, Message, Update

from app import intake
from app.bot.handlers import build_router
from app.bot.summary import SummaryBatcher
from app.config import Settings

OWNER = 111
STRANGER = 999


class FakeSession(BaseSession):
    def __init__(self, local_files: dict[str, Path]) -> None:
        super().__init__()
        self.local_files = local_files
        self.sent: list[TelegramMethod] = []

    async def make_request(self, bot: Bot, method: TelegramMethod[Any], timeout: int | None = None) -> Any:
        self.sent.append(method)
        if isinstance(method, GetFile):
            path = self.local_files[method.file_id]
            return File(file_id=method.file_id, file_unique_id=method.file_id + "u", file_path=str(path))
        if isinstance(method, SendMessage):
            return Message(message_id=1, date=datetime.now(timezone.utc),
                           chat=Chat(id=method.chat_id, type="private"), text=method.text)
        if isinstance(method, (AnswerCallbackQuery, EditMessageText)):
            return True
        raise AssertionError(f"unexpected method {type(method).__name__}")

    async def stream_content(self, *args: Any, **kwargs: Any):  # pragma: no cover - not used in local mode
        raise AssertionError("download should not be needed in local mode")
        yield b""

    async def close(self) -> None:
        pass


def update(user_id: int, **message: Any) -> Update:
    return Update.model_validate({
        "update_id": 1,
        "message": {
            "message_id": 10,
            "date": datetime.now(timezone.utc),
            "chat": {"id": user_id, "type": "private"},
            "from": {"id": user_id, "is_bot": False, "first_name": "T"},
            **message,
        },
    })


def texts(session: FakeSession) -> list[str]:
    return [m.text for m in session.sent if isinstance(m, SendMessage)]


async def setup(sessionmaker, tmp_path, files):
    settings = Settings(_env_file=None, bot_token="123:abc", allowed_user_ids=frozenset({OWNER}),
                        media_dir=tmp_path / "media", bot_api_local=True, summary_delay_s=0.05)
    settings.media_dir.mkdir(parents=True)
    session = FakeSession(files)
    bot = Bot("123:abc", session=session)
    batcher = SummaryBatcher(settings.summary_delay_s, lambda chat_id, text: bot.send_message(chat_id, text))
    dispatcher = Dispatcher()
    dispatcher.include_router(build_router(settings, sessionmaker, batcher))
    return settings, session, bot, dispatcher


async def test_owner_upload_is_saved_and_summarised(sessionmaker, tmp_path):
    raw = tmp_path / "botapi" / "documents" / "file_0.MOV"
    raw.parent.mkdir(parents=True)
    raw.write_bytes(b"\0" * 2048)
    settings, session, bot, dp = await setup(sessionmaker, tmp_path, {"vid1": raw})

    doc = {"file_id": "vid1", "file_unique_id": "uniq1", "file_name": "IMG_1.MOV", "mime_type": "video/quicktime"}
    await dp.feed_update(bot, update(OWNER, document=doc, caption="шторы до"))
    await dp.feed_update(bot, update(OWNER, document=doc))  # same file again
    await asyncio.sleep(0.2)

    summary = texts(session)[-1]
    assert "✅ Принято: 1 видео" in summary
    assert "Отпариватель (STM)" in summary
    assert "пропущено: 1" in summary
    assert not raw.exists(), "file must be moved out of the Bot API storage"
    async with sessionmaker() as s:
        rows = {r.code: r for r in await intake.library_stats(s)}
    assert rows["STM"].videos == 1


async def test_stranger_gets_id_and_nothing_is_stored(sessionmaker, tmp_path):
    settings, session, bot, dp = await setup(sessionmaker, tmp_path, {})
    await dp.feed_update(bot, update(STRANGER, text="/start"))
    assert "Нет доступа" in texts(session)[-1]
    assert str(STRANGER) in texts(session)[-1]


async def test_newproduct_then_caption_routes_to_product(sessionmaker, tmp_path):
    raw = tmp_path / "botapi" / "videos" / "file_1.mp4"
    raw.parent.mkdir(parents=True)
    raw.write_bytes(b"\0" * 10)
    settings, session, bot, dp = await setup(sessionmaker, tmp_path, {"v2": raw})

    await dp.feed_update(bot, update(OWNER, text="/newproduct brush Электрощётка", entities=[
        {"type": "bot_command", "offset": 0, "length": 11}]))
    assert "Электрощётка (BRUSH)" in texts(session)[-1]

    video = {"file_id": "v2", "file_unique_id": "u2", "width": 720, "height": 1280, "duration": 5}
    await dp.feed_update(bot, update(OWNER, video=video, caption="#STM пар"))
    await asyncio.sleep(0.2)
    assert "Отпариватель (STM)" in texts(session)[-1]
    assert "Telegram сжал" in texts(session)[-1]
