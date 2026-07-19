"""Key pool: selection strategies, per-key proxy rotation, cooldowns, stats."""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

from .config import ConfigStore, mask_key

logger = logging.getLogger("nvidia_hub.pool")

# HTTP statuses that put a key into cooldown
COOLDOWN_STATUSES = {401, 429}


class PoolEmpty(Exception):
    """No usable key in the pool."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def public_key_view(entry: dict[str, Any]) -> dict[str, Any]:
    """KeyEntry as exposed via API (full key never leaves the backend)."""
    return {
        "id": entry["id"],
        "label": entry.get("label", ""),
        "key_masked": mask_key(entry["key"]),
        "proxy_ids": list(entry.get("proxy_ids", [])),
        "enabled": bool(entry.get("enabled", True)),
        "status": entry.get("status", "active"),
        "stats": {
            "requests": entry["stats"].get("requests", 0),
            "errors": entry["stats"].get("errors", 0),
            "tokens": entry["stats"].get("tokens", 0),
            "avg_latency_ms": round(entry["stats"].get("avg_latency_ms", 0.0), 1),
            "last_error": entry["stats"].get("last_error"),
            "last_used_at": entry["stats"].get("last_used_at"),
        },
    }


def public_proxy_view(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry["id"],
        "url": entry["url"],
        "enabled": bool(entry.get("enabled", True)),
        "status": entry.get("status", "active"),
        "stats": {
            "requests": entry["stats"].get("requests", 0),
            "errors": entry["stats"].get("errors", 0),
            "last_error": entry["stats"].get("last_error"),
        },
    }


class KeyPool:
    def __init__(self, store: ConfigStore) -> None:
        self.store = store
        self._rr_cursor = 0

    # ---------- selection ----------

    def _revive_and_eligible(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        """Return usable keys, auto-returning keys whose cooldown expired."""
        now = time.time()
        eligible = []
        for k in data["keys"]:
            if not k.get("enabled", True):
                k["status"] = "disabled"
                continue
            if k.get("status") == "cooldown":
                until = k.get("cooldown_until") or 0
                if now >= until:
                    k["status"] = "active"
                    k["cooldown_until"] = None
                    logger.info("Key %s cooldown expired, back to active", k["id"])
                else:
                    continue
            if k.get("status") == "active":
                eligible.append(k)
        return eligible

    def _pick_proxy(self, data: dict[str, Any], key: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Next enabled+alive proxy from the key's proxy_ids, round-robin per key."""
        by_id = {p["id"]: p for p in data["proxies"]}
        candidates = [
            by_id[pid]
            for pid in key.get("proxy_ids", [])
            if pid in by_id and by_id[pid].get("enabled", True) and by_id[pid].get("status") == "active"
        ]
        if not candidates:
            return None
        cursor = key.get("proxy_cursor", 0) % len(candidates)
        key["proxy_cursor"] = cursor + 1
        return candidates[cursor]

    def _pick_key(self, data: dict[str, Any], exclude: set[str] | None = None) -> tuple[dict[str, Any], Optional[dict[str, Any]]]:
        eligible = self._revive_and_eligible(data)
        if exclude:
            eligible = [k for k in eligible if k["id"] not in exclude]
        if not eligible:
            raise PoolEmpty("no usable API keys in pool")
        strategy = data["settings"].get("strategy", "round_robin")
        if strategy == "least_used":
            key = min(eligible, key=lambda k: k["stats"].get("requests", 0))
        else:  # round_robin
            key = eligible[self._rr_cursor % len(eligible)]
            self._rr_cursor += 1
        proxy = self._pick_proxy(data, key)
        return key, proxy

    async def acquire(self, exclude_key_ids: set[str] | None = None) -> tuple[dict[str, Any], Optional[str]]:
        """Pick (key, proxy_url). Returns copies safe to use outside the lock."""

        def _do(data: dict[str, Any]) -> tuple[dict[str, Any], Optional[str]]:
            key, proxy = self._pick_key(data, exclude_key_ids)
            return dict(key), (proxy["url"] if proxy else None)

        return await self.store.mutate(_do, save=False)

    async def acquire_specific(self, key_id: str) -> tuple[dict[str, Any], Optional[str]]:
        """Pick a specific key by id (for the key test endpoint)."""

        def _do(data: dict[str, Any]) -> tuple[dict[str, Any], Optional[str]]:
            for k in data["keys"]:
                if k["id"] == key_id:
                    proxy = self._pick_proxy(data, k)
                    return dict(k), (proxy["url"] if proxy else None)
            raise KeyError(key_id)

        return await self.store.mutate(_do, save=False)

    # ---------- stats / health ----------

    async def report_success(self, key_id: str, proxy_url: Optional[str], latency_ms: float, tokens: int = 0) -> None:
        def _do(data: dict[str, Any]) -> None:
            for k in data["keys"]:
                if k["id"] == key_id:
                    st = k["stats"]
                    st["requests"] += 1
                    st["tokens"] += max(tokens, 0)
                    # exponential moving average of latency
                    st["avg_latency_ms"] = (
                        latency_ms if st["requests"] == 1 else st["avg_latency_ms"] * 0.8 + latency_ms * 0.2
                    )
                    st["last_used_at"] = _now_iso()
                    st["last_error"] = None
                    break
            if proxy_url:
                for p in data["proxies"]:
                    if p["url"] == proxy_url:
                        p["stats"]["requests"] += 1
                        if p.get("status") == "dead":
                            p["status"] = "active"
                            p["stats"]["last_error"] = None
                            logger.info("Proxy %s recovered", proxy_url)
                        break

        await self.store.mutate(_do, save=False)

    async def report_failure(
        self,
        key_id: str,
        proxy_url: Optional[str],
        error: str,
        http_status: Optional[int] = None,
        network_error: bool = False,
        cooldown_s: int = 60,
    ) -> None:
        def _do(data: dict[str, Any]) -> None:
            for k in data["keys"]:
                if k["id"] == key_id:
                    st = k["stats"]
                    st["requests"] += 1
                    st["errors"] += 1
                    st["last_error"] = error[:500]
                    st["last_used_at"] = _now_iso()
                    if http_status in COOLDOWN_STATUSES:
                        k["status"] = "cooldown"
                        k["cooldown_until"] = time.time() + cooldown_s
                        logger.warning("Key %s -> cooldown %ds (HTTP %s)", k["id"], cooldown_s, http_status)
                    break
            if proxy_url and network_error:
                # dead only on network errors, NOT on upstream HTTP errors
                for p in data["proxies"]:
                    if p["url"] == proxy_url:
                        p["status"] = "dead"
                        p["stats"]["errors"] += 1
                        p["stats"]["requests"] += 1
                        p["stats"]["last_error"] = error[:500]
                        logger.warning("Proxy %s marked dead: %s", proxy_url, error)
                        break
            elif proxy_url:
                for p in data["proxies"]:
                    if p["url"] == proxy_url:
                        p["stats"]["requests"] += 1
                        p["stats"]["errors"] += 1
                        p["stats"]["last_error"] = error[:500]
                        break

        await self.store.mutate(_do, save=False)
