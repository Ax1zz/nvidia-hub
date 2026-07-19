"""Persistent configuration store: data/config.json.

Stores API keys (full, on disk only), proxies and settings.
Atomic writes (tmp file + os.replace), asyncio lock for thread/task safety.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger("nvidia_hub.config")

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
CONFIG_PATH = DATA_DIR / "config.json"
WORKSPACE_DIR = BASE_DIR / "workspace"
STATIC_DIR = BASE_DIR / "static"

DEFAULT_SETTINGS: dict[str, Any] = {
    "strategy": "round_robin",  # round_robin | least_used
    "max_retries": 3,
    "cooldown_s": 60,
    "default_model": "meta/llama-3.1-8b-instruct",
    "port": 8400,
}


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def new_key_entry(key: str, label: str = "", proxy_ids: list[str] | None = None) -> dict[str, Any]:
    return {
        "id": _new_id(),
        "label": label or key[:10],
        "key": key,
        "proxy_ids": list(proxy_ids or []),
        "enabled": True,
        "status": "active",  # active | cooldown | disabled
        "cooldown_until": None,
        "proxy_cursor": 0,
        "stats": {
            "requests": 0,
            "errors": 0,
            "tokens": 0,
            "avg_latency_ms": 0.0,
            "last_error": None,
            "last_used_at": None,
        },
    }


def new_proxy_entry(url: str) -> dict[str, Any]:
    return {
        "id": _new_id(),
        "url": url,
        "enabled": True,
        "status": "active",  # active | dead | disabled
        "stats": {"requests": 0, "errors": 0, "last_error": None},
    }


class ConfigStore:
    """Async-locked persistent store backed by a single JSON file."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._data: dict[str, Any] = {"keys": [], "proxies": [], "settings": dict(DEFAULT_SETTINGS)}
        self._load()

    # ---------- persistence ----------

    def _load(self) -> None:
        if CONFIG_PATH.exists():
            try:
                raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self._data["keys"] = raw.get("keys", [])
                    self._data["proxies"] = raw.get("proxies", [])
                    settings = dict(DEFAULT_SETTINGS)
                    settings.update(raw.get("settings", {}))
                    self._data["settings"] = settings
                    logger.info("Loaded config: %d keys, %d proxies", len(self._data["keys"]), len(self._data["proxies"]))
            except Exception as exc:  # corrupted file -> start fresh, keep backup
                logger.error("Failed to load %s: %s", CONFIG_PATH, exc)
                backup = CONFIG_PATH.with_suffix(f".corrupt-{int(time.time())}.json")
                try:
                    os.replace(CONFIG_PATH, backup)
                except OSError:
                    pass

    def _save_unlocked(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG_PATH)

    async def save(self) -> None:
        async with self._lock:
            self._save_unlocked()

    # ---------- generic locked access ----------

    async def mutate(self, fn: Callable[[dict[str, Any]], Any], save: bool = True) -> Any:
        """Run fn(self._data) under the lock; persist afterwards."""
        async with self._lock:
            result = fn(self._data)
            if save:
                self._save_unlocked()
            return result

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            return copy.deepcopy(self._data)

    # ---------- settings ----------

    async def get_settings(self) -> dict[str, Any]:
        async with self._lock:
            return dict(self._data["settings"])

    async def patch_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        allowed = set(DEFAULT_SETTINGS)

        def _apply(data: dict[str, Any]) -> dict[str, Any]:
            for k, v in patch.items():
                if k in allowed and v is not None:
                    data["settings"][k] = v
            return dict(data["settings"])

        return await self.mutate(_apply)


def mask_key(key: str) -> str:
    if len(key) <= 10:
        return key[:2] + "..." + key[-2:]
    return key[:6] + "..." + key[-4:]
