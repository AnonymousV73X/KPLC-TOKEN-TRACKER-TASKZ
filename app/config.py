"""Application configuration via pydantic-settings. All settings loaded from env vars with sensible defaults."""

from pydantic_settings import BaseSettings
from functools import lru_cache
from pathlib import Path


class Settings(BaseSettings):
    # --- App ---
    APP_NAME: str = "TASKZ — KPLC Prepaid Token Tracker"
    DEBUG: bool = False
    SECRET_KEY: str = "change-me-in-production-use-a-long-random-string"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days

    # --- Database ---
    DATABASE_DIR: Path = Path(__file__).resolve().parent.parent / "data"
    DATABASE_NAME: str = "taskz.db"

    @property
    def DATABASE_URL(self) -> str:
        self.DATABASE_DIR.mkdir(parents=True, exist_ok=True)
        return f"sqlite+aiosqlite:///{self.DATABASE_DIR / self.DATABASE_NAME}"

    # --- KPLC Scraper ---
    KPLC_SEARCH_URL: str = "https://selfservice.kplc.co.ke/"
    KPLC_TIMEOUT: int = 30  # seconds
    SCRAPE_WINDOW_HOURS: int = 4  # spread polls across this window
    SCRAPE_INTERVAL_HOURS: int = 12  # cron poll runs every N hours (e.g. 00:00 & 12:00 UTC)

    # Minimum time since last scrape before a dashboard GET (page load/refresh)
    # is allowed to trigger its own live KPLC fetch. Prevents hammering KPLC
    # every time the dashboard re-renders (e.g. after a payer-label edit).
    AUTO_REFRESH_MIN_INTERVAL_MINUTES: int = 5

    # --- Usage Engine ---
    USAGE_WINDOW_DAYS: int = 30
    DEFAULT_NOTIFICATION_THRESHOLD_DAYS: float = 1.0
    DEFAULT_MANUAL_RATE: float | None = None

    # --- Telegram ---
    TELEGRAM_BOT_TOKEN: str = ""
    TELEGRAM_LINK_TOKEN_EXPIRE_MINUTES: int = 15

    # --- Polling ---
    ALERT_COOLDOWN_HOURS: int = 24

    model_config = {"env_prefix": "TASKZ_", "env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
