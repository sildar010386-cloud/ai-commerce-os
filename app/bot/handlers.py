import html
import logging
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware, Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message, TelegramObject
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import intake
from app.bot.summary import BatchEntry, SummaryBatcher, format_duration
from app.config import Settings
from app.db import Product
from app.media import probe

log = logging.getLogger(__name__)

PRODUCT_CODE_RE = re.compile(r"^[A-Za-z0-9]{2,16}$")

MIME_SUFFIX = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/webm": ".webm",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/heic": ".heic",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}

HELP_TEXT = (
    "<b>Контент-студия</b>\n\n"
    "Просто отправляйте сюда сырьё: видео, фото, озвучку. Можно пачкой, до 2 ГБ на файл.\n"
    "Лучше через 📎 → «Файл» — так Telegram не сжимает качество.\n\n"
    "Файлы попадают в библиотеку активного товара. Чтобы отправить файл в другой товар, "
    "добавьте в подпись код, например <code>#STM</code>.\n\n"
    "/product — выбрать активный товар\n"
    "/newproduct КОД Название — добавить товар (пример: <code>/newproduct BRUSH Электрощётка</code>)\n"
    "/library — что уже есть в библиотеке\n"
    "/help — эта подсказка"
)


class AccessMiddleware(BaseMiddleware):
    """Only allow-listed Telegram users reach the handlers. Strangers see their ID (handy during setup)."""

    def __init__(self, allowed_user_ids: frozenset[int]) -> None:
        self._allowed = allowed_user_ids

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        user = data.get("event_from_user")
        if user is not None and user.id in self._allowed:
            return await handler(event, data)
        user_id = user.id if user else "?"
        log.warning("Access denied for user %s", user_id)
        if isinstance(event, Message):
            await event.answer(
                f"Нет доступа.\nВаш Telegram ID: <code>{user_id}</code>\n"
                "Если это ваш бот — добавьте этот ID в настройки сервера (ALLOWED_USER_IDS)."
            )
        elif isinstance(event, CallbackQuery):
            await event.answer("Нет доступа", show_alert=True)
        return None


@dataclass(frozen=True)
class MediaRef:
    file_id: str
    file_unique_id: str
    kind: str  # video | photo | audio
    original_name: str | None
    suffix: str
    compressed: bool
    size: int | None


def extract_media(message: Message) -> MediaRef | None:
    if message.video:
        v = message.video
        return MediaRef(v.file_id, v.file_unique_id, "video", v.file_name,
                        _suffix(v.file_name, v.mime_type, ".mp4"), True, v.file_size)
    if message.video_note:
        v = message.video_note
        return MediaRef(v.file_id, v.file_unique_id, "video", None, ".mp4", True, v.file_size)
    if message.document:
        d = message.document
        mime = (d.mime_type or "").lower()
        kind = "video" if mime.startswith("video/") else "photo" if mime.startswith("image/") else (
            "audio" if mime.startswith("audio/") else None)
        if kind is None:
            return None
        return MediaRef(d.file_id, d.file_unique_id, kind, d.file_name,
                        _suffix(d.file_name, mime, ".bin"), False, d.file_size)
    if message.photo:
        p = message.photo[-1]  # largest size
        return MediaRef(p.file_id, p.file_unique_id, "photo", None, ".jpg", True, p.file_size)
    if message.audio:
        a = message.audio
        return MediaRef(a.file_id, a.file_unique_id, "audio", a.file_name,
                        _suffix(a.file_name, a.mime_type, ".mp3"), False, a.file_size)
    if message.voice:
        v = message.voice
        return MediaRef(v.file_id, v.file_unique_id, "audio", None, ".ogg", True, v.file_size)
    return None


def _suffix(file_name: str | None, mime: str | None, default: str) -> str:
    if file_name and Path(file_name).suffix:
        return Path(file_name).suffix.lower()
    return MIME_SUFFIX.get((mime or "").lower(), default)


def products_keyboard(products: list[Product], active_id: int | None) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(
            text=f"{'✅ ' if p.id == active_id else ''}{p.name} ({p.code})",
            callback_data=f"prod:{p.id}",
        )]
        for p in products
    ]
    return InlineKeyboardMarkup(inline_keyboard=rows)


def product_label(product: Product | None) -> str | None:
    return f"{html.escape(product.name)} ({product.code})" if product else None


def build_router(
    settings: Settings,
    sessionmaker: async_sessionmaker[AsyncSession],
    batcher: SummaryBatcher,
) -> Router:
    router = Router()
    access = AccessMiddleware(settings.allowed_user_ids)
    router.message.outer_middleware(access)
    router.callback_query.outer_middleware(access)

    incoming_dir = settings.media_dir / ".incoming"

    @router.message(CommandStart())
    @router.message(Command("help"))
    async def cmd_help(message: Message) -> None:
        async with sessionmaker() as session:
            active = await intake.get_active_product(session, message.from_user.id)
        suffix = f"\n\nАктивный товар: <b>{product_label(active)}</b>" if active else ""
        await message.answer(HELP_TEXT + suffix)

    @router.message(Command("product"))
    async def cmd_product(message: Message) -> None:
        async with sessionmaker() as session:
            products = await intake.list_products(session)
            active = await intake.get_active_product(session, message.from_user.id)
        await message.answer(
            "Выберите товар — новое сырьё пойдёт в его библиотеку:",
            reply_markup=products_keyboard(products, active.id if active else None),
        )

    @router.callback_query(F.data.startswith("prod:"))
    async def cb_product(callback: CallbackQuery) -> None:
        product_id = int(callback.data.split(":", 1)[1])
        async with sessionmaker() as session:
            product = await session.get(Product, product_id)
            if product is None:
                await callback.answer("Товар не найден", show_alert=True)
                return
            await intake.set_active_product(session, callback.from_user.id, product)
            products = await intake.list_products(session)
        await callback.message.edit_text(
            f"Активный товар: <b>{product_label(product)}</b>\nОтправляйте сырьё.",
            reply_markup=products_keyboard(products, product.id),
        )
        await callback.answer()

    @router.message(Command("newproduct"))
    async def cmd_newproduct(message: Message, command: CommandObject) -> None:
        parts = (command.args or "").split(maxsplit=1)
        if len(parts) < 2 or not PRODUCT_CODE_RE.match(parts[0]):
            await message.answer(
                "Формат: <code>/newproduct КОД Название</code>\n"
                "КОД — 2–16 латинских букв или цифр. Пример: <code>/newproduct BRUSH Электрощётка</code>"
            )
            return
        code, name = parts[0].upper(), parts[1]
        async with sessionmaker() as session:
            if await intake.get_product(session, code):
                await message.answer(f"Товар с кодом {code} уже есть. /product — выбрать его.")
                return
            product = await intake.create_product(session, code, name)
            await intake.set_active_product(session, message.from_user.id, product)
        await message.answer(f"Добавлен и выбран товар: <b>{product_label(product)}</b>\nОтправляйте сырьё.")

    @router.message(Command("library"))
    async def cmd_library(message: Message) -> None:
        async with sessionmaker() as session:
            rows = await intake.library_stats(session)
        if not rows:
            await message.answer("Товаров пока нет. /newproduct — добавить.")
            return
        lines = ["<b>Библиотека сырья</b>"]
        for row in rows:
            lines.append(
                f"\n<b>{html.escape(row.name)} ({row.code})</b>\n"
                f"Видео: {row.videos} ({format_duration(row.video_seconds or 0)}) · "
                f"Фото: {row.photos} · Аудио: {row.audios}"
            )
        free_gb = shutil.disk_usage(settings.media_dir).free / 1024**3
        lines.append(f"\nСвободно на сервере: {free_gb:.0f} ГБ")
        await message.answer("\n".join(lines))

    @router.message(F.video | F.video_note | F.document | F.photo | F.audio | F.voice)
    async def on_media(message: Message, bot: Bot) -> None:
        ref = extract_media(message)
        chat_id = message.chat.id
        if ref is None:
            batcher.add(chat_id, BatchEntry("error", error="не видео, фото или аудио"))
            return

        async with sessionmaker() as session:
            code = intake.product_code_from_caption(message.caption)
            product = await intake.get_product(session, code) if code else None
            if product is None:
                product = await intake.get_active_product(session, message.from_user.id)
            label = product_label(product)

            if await intake.find_duplicate(session, ref.file_unique_id):
                batcher.add(chat_id, BatchEntry("duplicate", ref.kind, label))
                return

            free = shutil.disk_usage(settings.media_dir).free
            if free < settings.min_free_disk_gb * 1024**3:
                batcher.add(chat_id, BatchEntry("error", ref.kind, label, error="на сервере мало места"))
                return

            try:
                source, move = await _fetch(bot, ref, incoming_dir, settings.bot_api_local)
            except TelegramBadRequest as exc:
                reason = "файл больше 20 МБ (нужен локальный Bot API)" if "too big" in str(exc) else str(exc)
                batcher.add(chat_id, BatchEntry("error", ref.kind, label, error=reason))
                return

            info = await probe(source)
            result = await intake.store_clip(
                session,
                media_dir=settings.media_dir,
                source=source,
                move_source=move,
                product=product,
                kind=ref.kind,
                file_unique_id=ref.file_unique_id,
                info=info,
                user_id=message.from_user.id,
                message_id=message.message_id,
                original_name=ref.original_name,
                caption=message.caption,
                compressed=ref.compressed,
            )
        batcher.add(chat_id, BatchEntry(result.status, ref.kind, label, info.duration_s, ref.compressed))

    return router


async def _fetch(bot: Bot, ref: MediaRef, incoming_dir: Path, local_mode: bool) -> tuple[Path, bool]:
    """Return a local path to the file and whether it may be moved (not copied) into the library.

    With a local Bot API server the file already sits on this machine's disk, so it is moved
    instead of downloaded again.
    """
    tg_file = await bot.get_file(ref.file_id)
    if local_mode and tg_file.file_path and Path(tg_file.file_path).is_absolute():
        local_path = Path(tg_file.file_path)
        if local_path.exists():
            return local_path, True
    incoming_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(tg_file.file_path or "").suffix or ref.suffix
    destination = incoming_dir / f"{uuid.uuid4().hex}{suffix}"
    await bot.download_file(tg_file.file_path, destination, timeout=900)
    return destination, True
