from pathlib import Path

from app import intake
from app.media import MediaInfo


def make_source(tmp_path: Path, name: str = "raw.MOV", size: int = 1024) -> Path:
    source = tmp_path / "incoming" / name
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"\0" * size)
    return source


async def store(session, tmp_path, product, unique_id="u1", source=None, move=True):
    return await intake.store_clip(
        session,
        media_dir=tmp_path / "media",
        source=source or make_source(tmp_path),
        move_source=move,
        product=product,
        kind="video",
        file_unique_id=unique_id,
        info=MediaInfo(duration_s=12.5, width=1080, height=1920, fps=30.0, codec="hevc"),
        user_id=42,
        message_id=7,
        original_name="IMG_0001.MOV",
        caption="#STM шторы",
        compressed=False,
    )


async def test_default_product_seeded_and_active(sessionmaker):
    async with sessionmaker() as session:
        products = await intake.list_products(session)
        active = await intake.get_active_product(session, user_id=42)
    assert [p.code for p in products] == ["STM"]
    assert active.code == "STM"


async def test_store_clip_moves_file_into_product_folder(sessionmaker, tmp_path):
    source = make_source(tmp_path)
    async with sessionmaker() as session:
        product = await intake.get_product(session, "stm")
        result = await store(session, tmp_path, product, source=source)

    assert result.status == "saved"
    stored = tmp_path / "media" / result.clip.path
    assert stored.exists() and stored.suffix == ".mov"
    assert result.clip.path.startswith("STM/")
    assert not source.exists()
    assert result.clip.size_bytes == 1024
    assert (result.clip.width, result.clip.height) == (1080, 1920)


async def test_store_clip_is_idempotent_on_file_unique_id(sessionmaker, tmp_path):
    async with sessionmaker() as session:
        product = await intake.get_product(session, "STM")
        first = await store(session, tmp_path, product, unique_id="same")
        second = await store(session, tmp_path, product, unique_id="same", source=make_source(tmp_path, "b.mp4"))
    assert first.status == "saved"
    assert second.status == "duplicate"
    assert second.clip.id == first.clip.id


async def test_copy_mode_keeps_source(sessionmaker, tmp_path):
    source = make_source(tmp_path)
    async with sessionmaker() as session:
        product = await intake.get_product(session, "STM")
        await store(session, tmp_path, product, source=source, move=False)
    assert source.exists()


async def test_active_product_switch_and_library_stats(sessionmaker, tmp_path):
    async with sessionmaker() as session:
        brush = await intake.create_product(session, "brush", "Электрощётка")
        await intake.set_active_product(session, 42, brush)
        assert (await intake.get_active_product(session, 42)).code == "BRUSH"

        stm = await intake.get_product(session, "STM")
        await store(session, tmp_path, stm, unique_id="a", source=make_source(tmp_path, "a.mp4"))
        await store(session, tmp_path, stm, unique_id="b", source=make_source(tmp_path, "b.mp4"))
        rows = {row.code: row for row in await intake.library_stats(session)}

    assert rows["STM"].videos == 2
    assert rows["STM"].video_seconds == 25.0
    assert rows["BRUSH"].videos == 0


def test_product_code_from_caption():
    assert intake.product_code_from_caption("#stm шторы до/после") == "STM"
    assert intake.product_code_from_caption("шторы") is None
    assert intake.product_code_from_caption(None) is None


def test_build_relative_path_without_product():
    path = intake.build_relative_path(None, ".MP4")
    assert path.parts[0] == "_unsorted"
    assert path.suffix == ".mp4"
