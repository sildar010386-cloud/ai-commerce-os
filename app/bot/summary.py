"""One summary message per upload burst instead of a reply to every file."""

import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass
from typing import Awaitable, Callable

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class BatchEntry:
    status: str  # saved | duplicate | error
    kind: str | None = None  # video | photo | audio
    product_label: str | None = None
    duration_s: float | None = None
    compressed: bool = False
    error: str | None = None


def format_duration(seconds: float) -> str:
    total = int(round(seconds))
    minutes, secs = divmod(total, 60)
    return f"{minutes} мин {secs} сек" if minutes else f"{secs} сек"


def format_summary(entries: list[BatchEntry]) -> str:
    saved = [e for e in entries if e.status == "saved"]
    duplicates = [e for e in entries if e.status == "duplicate"]
    errors = [e for e in entries if e.status == "error"]
    lines: list[str] = []

    by_product: dict[str, list[BatchEntry]] = defaultdict(list)
    for entry in saved:
        by_product[entry.product_label or "Без товара"].append(entry)
    for label, items in by_product.items():
        videos = [e for e in items if e.kind == "video"]
        parts = []
        if videos:
            seconds = sum(e.duration_s or 0 for e in videos)
            parts.append(f"{len(videos)} видео ({format_duration(seconds)})")
        photos = sum(1 for e in items if e.kind == "photo")
        if photos:
            parts.append(f"{photos} фото")
        audios = sum(1 for e in items if e.kind == "audio")
        if audios:
            parts.append(f"{audios} аудио")
        lines.append(f"✅ Принято: {', '.join(parts)}\nТовар: {label}")

    if duplicates:
        lines.append(f"↩️ Уже были в библиотеке, пропущено: {len(duplicates)}")
    if errors:
        reasons = sorted({e.error or "неизвестная ошибка" for e in errors})
        lines.append(f"❌ Не принято: {len(errors)} — " + "; ".join(reasons))

    compressed = sum(1 for e in saved if e.kind == "video" and e.compressed)
    if compressed:
        lines.append(
            f"⚠️ {compressed} видео Telegram сжал. Для лучшего качества отправляйте "
            "через 📎 → «Файл», а не как видео."
        )
    return "\n\n".join(lines) if lines else "Файлы не получены."


class SummaryBatcher:
    """Collects intake results per chat and sends one summary after `delay` seconds of quiet."""

    def __init__(self, delay: float, send: Callable[[int, str], Awaitable[object]]) -> None:
        self._delay = delay
        self._send = send
        self._entries: dict[int, list[BatchEntry]] = defaultdict(list)
        self._tasks: dict[int, asyncio.Task] = {}

    def add(self, chat_id: int, entry: BatchEntry) -> None:
        self._entries[chat_id].append(entry)
        task = self._tasks.get(chat_id)
        if task and not task.done():
            task.cancel()
        self._tasks[chat_id] = asyncio.create_task(self._flush_later(chat_id))

    async def _flush_later(self, chat_id: int) -> None:
        try:
            await asyncio.sleep(self._delay)
        except asyncio.CancelledError:
            return
        entries = self._entries.pop(chat_id, [])
        self._tasks.pop(chat_id, None)
        if entries:
            try:
                await self._send(chat_id, format_summary(entries))
            except Exception:
                log.exception("Failed to send intake summary to chat %s", chat_id)
