from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration comes from environment variables (.env on the server). No secrets in code."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    bot_token: str
    # Telegram user IDs allowed to use the bot, comma-separated in env: "123,456".
    allowed_user_ids: Annotated[frozenset[int], NoDecode] = frozenset()

    database_url: str = "postgresql+asyncpg://aicos:aicos@db:5432/aicos"
    media_dir: Path = Path("/data/media")
    state_dir: Path = Path("/data/state")

    # Local Telegram Bot API server lifts the 20 MB download limit to 2 GB.
    bot_api_url: str | None = "http://telegram-bot-api:8081"
    bot_api_local: bool = True

    min_free_disk_gb: float = 5.0
    summary_delay_s: float = 3.0

    @field_validator("allowed_user_ids", mode="before")
    @classmethod
    def _parse_ids(cls, value: object) -> object:
        if isinstance(value, str):
            return frozenset(int(part) for part in value.replace(" ", "").split(",") if part)
        if isinstance(value, int):
            return frozenset({value})
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
