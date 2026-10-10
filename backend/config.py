"""Application configuration loaded before backend services are initialized."""
from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = PROJECT_ROOT / ".env"


def load_project_environment() -> bool:
    """Load the project's local environment without overriding process settings."""
    return load_dotenv(dotenv_path=ENV_FILE, override=False)
