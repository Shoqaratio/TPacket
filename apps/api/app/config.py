from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repository root in a source checkout (apps/api/app/config.py). In the container the grader path
# comes from NETLAB_GRADER_PATH, and the tree is shallower, so do not assume this depth exists.
_parents = Path(__file__).resolve().parents
ROOT = _parents[3] if len(_parents) > 3 else _parents[-1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NETLAB_", env_file=".env", extra="ignore")

    env: str = "development"
    database_url: str = "sqlite:///./netlab-dev.db"
    # Cookies must be Secure in production (served over HTTPS behind Nginx).
    cookie_secure: bool = False
    session_days: int = 14
    cors_origins: list[str] = ["http://localhost:5173"]
    campus_redis_url: str | None = None
    node_bin: str = "node"
    grader_path: str = str(ROOT / "packages" / "engine" / "dist" / "grader.mjs")
    grader_timeout_s: float = 20.0
    grader_max_heap_mb: int = 256
    # Jobs left 'running' longer than this (crash, restart) are graded again at startup.
    grading_stale_after_s: float = 900.0
    recover_jobs_on_startup: bool = True
    # At most this many grader subprocesses run at once per API process (each may use a full CPU).
    grader_concurrency: int = 2
    # Interactive checks wait this long for a free slot before answering 503 (background jobs wait).
    grader_queue_wait_s: float = 5.0
    # Per-user limits on the endpoints that start the grader.
    checks_per_minute: int = 6
    submissions_per_minute: int = 5
    max_project_bytes: int = 4 * 1024 * 1024
    login_attempts_per_15min: int = 10
    # Optional OpenAI-compatible endpoint for TPacket Tutor (e.g. http://ollama:11434/v1). Empty = disabled.
    ai_url: str | None = None
    ai_key: str | None = None
    ai_model: str = "llama3.1"


@lru_cache
def get_settings() -> Settings:
    return Settings()
