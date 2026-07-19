"""Persistent chat history store: data/chats.json.

Same approach as config.py: asyncio lock + atomic write (tmp + os.replace).
Limits: 200 chats max (oldest by updated_at evicted), 500 messages per chat.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from .config import DATA_DIR

logger = logging.getLogger("nvidia_hub.chats")

CHATS_PATH = DATA_DIR / "chats.json"
MAX_CHATS = 200
MAX_MESSAGES = 500

DEFAULT_PARAMS: dict[str, Any] = {
    "temperature": 0.7,
    "top_p": 1.0,
    "max_tokens": 2048,
    "system_prompt": "",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def chat_meta(chat: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": chat["id"],
        "title": chat["title"],
        "model": chat["model"],
        "created_at": chat["created_at"],
        "updated_at": chat["updated_at"],
        "message_count": len(chat.get("messages", [])),
    }


class ChatStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._chats: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if CHATS_PATH.exists():
            try:
                raw = json.loads(CHATS_PATH.read_text(encoding="utf-8"))
                if isinstance(raw, list):
                    for chat in raw:
                        if isinstance(chat, dict) and chat.get("id"):
                            self._chats[chat["id"]] = chat
                    logger.info("Loaded %d chats", len(self._chats))
            except Exception as exc:
                logger.error("Failed to load %s: %s", CHATS_PATH, exc)
                backup = CHATS_PATH.with_suffix(f".corrupt-{int(datetime.now().timestamp())}.json")
                try:
                    os.replace(CHATS_PATH, backup)
                except OSError:
                    pass

    def _save_unlocked(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CHATS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(list(self._chats.values()), ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, CHATS_PATH)

    def _enforce_limits_unlocked(self) -> None:
        if len(self._chats) > MAX_CHATS:
            by_updated = sorted(self._chats.values(), key=lambda c: c.get("updated_at", ""))
            for chat in by_updated[: len(self._chats) - MAX_CHATS]:
                del self._chats[chat["id"]]

    async def _mutate(self, fn: Callable[[], Any]) -> Any:
        async with self._lock:
            result = fn()
            self._enforce_limits_unlocked()
            self._save_unlocked()
            return result

    # ---------- CRUD ----------

    async def list_meta(self) -> list[dict[str, Any]]:
        async with self._lock:
            metas = [chat_meta(c) for c in self._chats.values()]
        metas.sort(key=lambda m: m["updated_at"], reverse=True)
        return metas

    async def get(self, chat_id: str) -> Optional[dict[str, Any]]:
        async with self._lock:
            chat = self._chats.get(chat_id)
            return copy.deepcopy(chat) if chat else None

    async def upsert(self, body: dict[str, Any]) -> dict[str, Any]:
        """Create or fully replace a chat. Keep created_at on replace, bump updated_at."""
        now = _now_iso()

        def _do() -> dict[str, Any]:
            chat_id = body.get("id")
            existing = self._chats.get(chat_id) if chat_id else None
            params = dict(DEFAULT_PARAMS)
            if isinstance(body.get("params"), dict):
                params.update(body["params"])
            messages = list(body.get("messages") or [])[:MAX_MESSAGES]
            if existing:
                chat = {
                    "id": existing["id"],
                    "title": body.get("title") or existing.get("title") or "Новый чат",
                    "model": body.get("model") or existing.get("model") or "",
                    "params": params,
                    "messages": messages,
                    "created_at": existing.get("created_at", now),
                    "updated_at": now,
                }
            else:
                chat = {
                    "id": chat_id or _new_id(),
                    "title": body.get("title") or "Новый чат",
                    "model": body.get("model") or "",
                    "params": params,
                    "messages": messages,
                    "created_at": now,
                    "updated_at": now,
                }
            self._chats[chat["id"]] = chat
            return copy.deepcopy(chat)

        return await self._mutate(_do)

    async def rename(self, chat_id: str, title: str) -> Optional[dict[str, Any]]:
        def _do() -> Optional[dict[str, Any]]:
            chat = self._chats.get(chat_id)
            if not chat:
                return None
            chat["title"] = title
            chat["updated_at"] = _now_iso()
            return copy.deepcopy(chat)

        return await self._mutate(_do)

    async def delete(self, chat_id: str) -> bool:
        def _do() -> bool:
            return self._chats.pop(chat_id, None) is not None

        return await self._mutate(_do)
