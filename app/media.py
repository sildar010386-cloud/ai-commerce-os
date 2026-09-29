import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class MediaInfo:
    duration_s: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    codec: str | None = None


def _parse_fps(rate: str | None) -> float | None:
    if not rate or rate in ("0/0", "0"):
        return None
    num, _, den = rate.partition("/")
    try:
        value = float(num) / float(den) if den else float(num)
    except (ValueError, ZeroDivisionError):
        return None
    return round(value, 2) if value > 0 else None


def _rotation(stream: dict) -> int:
    rotate = stream.get("tags", {}).get("rotate")
    if rotate is not None:
        return int(float(rotate))
    for side in stream.get("side_data_list", []):
        if "rotation" in side:
            return int(float(side["rotation"]))
    return 0


def parse_probe_json(data: dict) -> MediaInfo:
    """Extract what we need from `ffprobe -show_streams -show_format` output.

    Phones store portrait video as landscape + rotation metadata, so width/height are swapped
    for ±90° rotation to reflect what the viewer actually sees.
    """
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = fmt.get("duration") or (video or audio or {}).get("duration")
    info_stream = video or audio or {}
    width, height = video.get("width") if video else None, video.get("height") if video else None
    if video and width and height and abs(_rotation(video)) % 180 == 90:
        width, height = height, width

    return MediaInfo(
        duration_s=round(float(duration), 2) if duration else None,
        width=width,
        height=height,
        fps=_parse_fps(video.get("avg_frame_rate")) if video else None,
        codec=info_stream.get("codec_name"),
    )


async def probe(path: Path) -> MediaInfo:
    """Read media metadata with ffprobe. Never raises: a broken or unknown file gives empty info."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
    except FileNotFoundError:
        log.warning("ffprobe not installed; skipping metadata for %s", path)
        return MediaInfo()
    if proc.returncode != 0:
        log.warning("ffprobe failed for %s: %s", path, stderr.decode(errors="replace")[:300])
        return MediaInfo()
    return parse_probe_json(json.loads(stdout or b"{}"))
