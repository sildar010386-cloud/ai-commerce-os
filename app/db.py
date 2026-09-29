from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Clip(Base):
    """One raw media file received from the owner (video, photo or audio)."""

    __tablename__ = "clips"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"))
    kind: Mapped[str] = mapped_column(String(16))  # video | photo | audio
    tg_file_unique_id: Mapped[str] = mapped_column(String(128), unique=True)
    tg_message_id: Mapped[int | None] = mapped_column(BigInteger)
    received_by: Mapped[int] = mapped_column(BigInteger)
    original_name: Mapped[str | None] = mapped_column(String(300))
    path: Mapped[str] = mapped_column(String(500))  # relative to media_dir
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    duration_s: Mapped[float | None] = mapped_column(Float)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    fps: Mapped[float | None] = mapped_column(Float)
    codec: Mapped[str | None] = mapped_column(String(32))
    # True when Telegram re-encoded the video (sent as "video", not as "file").
    compressed: Mapped[bool] = mapped_column(Boolean, default=False)
    caption: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="new")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    product: Mapped[Product | None] = relationship()


class UserState(Base):
    __tablename__ = "user_state"

    tg_user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    active_product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"))


DEFAULT_PRODUCTS = [("STM", "Отпариватель")]


def make_engine(database_url: str) -> AsyncEngine:
    return create_async_engine(database_url, pool_pre_ping=True)


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def init_db(engine: AsyncEngine, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    """Create tables and seed default products. Alembic migrations replace this once the schema starts changing."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with sessionmaker() as session:
        existing = set((await session.scalars(select(Product.code))).all())
        for code, name in DEFAULT_PRODUCTS:
            if code not in existing:
                session.add(Product(code=code, name=name))
        await session.commit()
