"""Receiving raw media from the owner: dedupe, store on disk, record in the database.

Telegram-independent so it can be tested without a bot.
"""

import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import Clip, Product, UserState
from app.media import MediaInfo

CODE_RE = re.compile(r"#([A-Za-z0-9]{2,16})\b")


@dataclass
class IntakeResult:
    status: str  # saved | duplicate
    clip: Clip


def product_code_from_caption(caption: str | None) -> str | None:
    """A caption like "#STM шторы" sends this file to product STM regardless of the active product."""
    if not caption:
        return None
    match = CODE_RE.search(caption)
    return match.group(1).upper() if match else None


def build_relative_path(product_code: str | None, suffix: str, now: datetime | None = None) -> Path:
    now = now or datetime.now(timezone.utc)
    folder = product_code or "_unsorted"
    return Path(folder) / now.strftime("%Y-%m-%d") / f"{uuid.uuid4().hex[:12]}{suffix.lower()}"


async def find_duplicate(session: AsyncSession, file_unique_id: str) -> Clip | None:
    return await session.scalar(select(Clip).where(Clip.tg_file_unique_id == file_unique_id))


async def get_product(session: AsyncSession, code: str) -> Product | None:
    return await session.scalar(select(Product).where(Product.code == code.upper()))


async def list_products(session: AsyncSession) -> list[Product]:
    return list((await session.scalars(select(Product).order_by(Product.id))).all())


async def create_product(session: AsyncSession, code: str, name: str) -> Product:
    product = Product(code=code.upper(), name=name.strip())
    session.add(product)
    await session.commit()
    return product


async def get_active_product(session: AsyncSession, user_id: int) -> Product | None:
    state = await session.get(UserState, user_id)
    if state and state.active_product_id:
        return await session.get(Product, state.active_product_id)
    # Before the owner picks anything, default to the first product.
    return await session.scalar(select(Product).order_by(Product.id).limit(1))


async def set_active_product(session: AsyncSession, user_id: int, product: Product) -> None:
    state = await session.get(UserState, user_id)
    if state is None:
        session.add(UserState(tg_user_id=user_id, active_product_id=product.id))
    else:
        state.active_product_id = product.id
    await session.commit()


async def store_clip(
    session: AsyncSession,
    *,
    media_dir: Path,
    source: Path,
    move_source: bool,
    product: Product | None,
    kind: str,
    file_unique_id: str,
    info: MediaInfo,
    user_id: int,
    message_id: int | None,
    original_name: str | None,
    caption: str | None,
    compressed: bool,
) -> IntakeResult:
    """Put the file into the media library and record it. Idempotent on Telegram's file_unique_id."""
    existing = await find_duplicate(session, file_unique_id)
    if existing is not None:
        return IntakeResult("duplicate", existing)

    suffix = source.suffix or Path(original_name or "").suffix or ".bin"
    relative = build_relative_path(product.code if product else None, suffix)
    target = media_dir / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if move_source:
        shutil.move(source, target)
    else:
        shutil.copy2(source, target)

    clip = Clip(
        product_id=product.id if product else None,
        kind=kind,
        tg_file_unique_id=file_unique_id,
        tg_message_id=message_id,
        received_by=user_id,
        original_name=original_name,
        path=relative.as_posix(),
        size_bytes=target.stat().st_size,
        duration_s=info.duration_s,
        width=info.width,
        height=info.height,
        fps=info.fps,
        codec=info.codec,
        compressed=compressed,
        caption=caption,
    )
    session.add(clip)
    await session.commit()
    return IntakeResult("saved", clip)


@dataclass
class LibraryRow:
    code: str
    name: str
    videos: int
    photos: int
    audios: int
    video_seconds: float
    last_received: datetime | None


async def library_stats(session: AsyncSession) -> list[LibraryRow]:
    rows = await session.execute(
        select(
            Product.code,
            Product.name,
            func.count(Clip.id).filter(Clip.kind == "video"),
            func.count(Clip.id).filter(Clip.kind == "photo"),
            func.count(Clip.id).filter(Clip.kind == "audio"),
            func.coalesce(func.sum(Clip.duration_s).filter(Clip.kind == "video"), 0.0),
            func.max(Clip.created_at),
        )
        .select_from(Product)
        .outerjoin(Clip, Clip.product_id == Product.id)
        .group_by(Product.id, Product.code, Product.name)
        .order_by(Product.id)
    )
    return [LibraryRow(*row) for row in rows.all()]
