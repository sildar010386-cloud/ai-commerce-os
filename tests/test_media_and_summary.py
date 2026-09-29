from datetime import datetime, timezone

from aiogram.types import Message

from app.bot.handlers import extract_media
from app.bot.summary import BatchEntry, format_duration, format_summary
from app.config import Settings
from app.media import parse_probe_json


def test_parse_probe_swaps_dimensions_for_rotated_phone_video():
    data = {
        "format": {"duration": "12.345"},
        "streams": [
            {"codec_type": "video", "codec_name": "hevc", "width": 1920, "height": 1080,
             "avg_frame_rate": "30000/1001", "side_data_list": [{"rotation": -90}]},
            {"codec_type": "audio", "codec_name": "aac"},
        ],
    }
    info = parse_probe_json(data)
    assert (info.width, info.height) == (1080, 1920)
    assert info.duration_s == 12.35
    assert info.fps == 29.97
    assert info.codec == "hevc"


def test_parse_probe_audio_only():
    info = parse_probe_json({"format": {"duration": "3.2"}, "streams": [{"codec_type": "audio", "codec_name": "mp3"}]})
    assert info.duration_s == 3.2
    assert info.width is None
    assert info.codec == "mp3"


def test_parse_probe_empty():
    info = parse_probe_json({})
    assert info.duration_s is None


def test_format_summary_groups_and_warns_about_compression():
    entries = [
        BatchEntry("saved", "video", "Отпариватель (STM)", 30.0, compressed=True),
        BatchEntry("saved", "video", "Отпариватель (STM)", 45.0),
        BatchEntry("saved", "photo", "Отпариватель (STM)"),
        BatchEntry("duplicate", "video", "Отпариватель (STM)"),
        BatchEntry("error", "video", "Отпариватель (STM)", error="на сервере мало места"),
    ]
    text = format_summary(entries)
    assert "2 видео (1 мин 15 сек), 1 фото" in text
    assert "Уже были в библиотеке, пропущено: 1" in text
    assert "Не принято: 1 — на сервере мало места" in text
    assert "1 видео Telegram сжал" in text


def test_format_duration():
    assert format_duration(9.6) == "10 сек"
    assert format_duration(125) == "2 мин 5 сек"


def _message(**media) -> Message:
    return Message.model_validate({
        "message_id": 1,
        "date": datetime.now(timezone.utc),
        "chat": {"id": 1, "type": "private"},
        **media,
    })


def test_extract_media_document_video_is_uncompressed():
    msg = _message(document={"file_id": "f", "file_unique_id": "u", "file_name": "IMG_1.MOV", "mime_type": "video/quicktime"})
    ref = extract_media(msg)
    assert (ref.kind, ref.compressed, ref.suffix) == ("video", False, ".mov")


def test_extract_media_telegram_video_is_compressed():
    msg = _message(video={"file_id": "f", "file_unique_id": "u", "width": 720, "height": 1280, "duration": 10})
    ref = extract_media(msg)
    assert (ref.kind, ref.compressed, ref.suffix) == ("video", True, ".mp4")


def test_extract_media_rejects_other_documents():
    msg = _message(document={"file_id": "f", "file_unique_id": "u", "file_name": "a.pdf", "mime_type": "application/pdf"})
    assert extract_media(msg) is None


def test_extract_media_photo_takes_largest():
    msg = _message(photo=[
        {"file_id": "small", "file_unique_id": "s", "width": 90, "height": 90},
        {"file_id": "big", "file_unique_id": "b", "width": 1280, "height": 1280},
    ])
    assert extract_media(msg).file_id == "big"


def test_settings_parse_allowed_ids(monkeypatch):
    monkeypatch.setenv("ALLOWED_USER_IDS", "123, 456")
    settings = Settings(_env_file=None)
    assert settings.allowed_user_ids == frozenset({123, 456})
