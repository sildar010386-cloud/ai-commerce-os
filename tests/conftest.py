import os

import pytest

from app.db import init_db, make_engine, make_sessionmaker

# Settings require a token; tests never talk to Telegram.
os.environ.setdefault("BOT_TOKEN", "123:test")

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite+aiosqlite:///:memory:")


@pytest.fixture
async def sessionmaker():
    engine = make_engine(TEST_DATABASE_URL)
    maker = make_sessionmaker(engine)
    async with engine.begin() as conn:
        from app.db import Base

        await conn.run_sync(Base.metadata.drop_all)
    await init_db(engine, maker)
    yield maker
    await engine.dispose()
