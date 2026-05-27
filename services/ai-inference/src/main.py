"""Entrypoint used when invoking the service via `python -m src.main`.

Compose / production deployments use uvicorn directly (see Dockerfile).
"""

from __future__ import annotations

import os

import uvicorn

from .app import app  # noqa: F401 — re-exported for uvicorn discovery


def main() -> None:
    uvicorn.run(
        "src.app:app",
        host="0.0.0.0",  # noqa: S104 — service is intentionally bound for Compose
        port=int(os.environ.get("PORT", "8000")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
