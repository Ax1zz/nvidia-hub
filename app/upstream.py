"""Upstream communication with NVIDIA's OpenAI-compatible API, with retries."""
from __future__ import annotations

import json
import logging
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

import httpx

from .pool import KeyPool, PoolEmpty

logger = logging.getLogger("nvidia_hub.upstream")

UPSTREAM_BASE = "https://integrate.api.nvidia.com/v1"
REQUEST_TIMEOUT = httpx.Timeout(120.0, connect=20.0)


def mask_proxy_url(url: Optional[str]) -> Optional[str]:
    """Mask password in proxy URL: http://user:pass@host:port -> http://user:•••@host:port."""
    if not url:
        return None
    try:
        from urllib.parse import urlsplit, urlunsplit

        parts = urlsplit(url)
        if parts.password:
            netloc = f"{parts.username}:•••@{parts.hostname}"
            if parts.port:
                netloc += f":{parts.port}"
            return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    except ValueError:
        pass
    return url


class RequestLog:
    """In-memory ring buffer of the last 100 proxy request attempts (newest first)."""

    def __init__(self, maxlen: int = 100) -> None:
        self._buf: deque[dict[str, Any]] = deque(maxlen=maxlen)

    def add(self, *, model: str, key_label: str, proxy_url: Optional[str],
            status: Optional[int], latency_ms: float, tokens: int = 0,
            stream: bool = False, error: Optional[str] = None) -> None:
        self._buf.appendleft({
            "ts": datetime.now(timezone.utc).isoformat(),
            "model": model,
            "key_label": key_label,
            "proxy": mask_proxy_url(proxy_url),
            "status": status,
            "latency_ms": round(latency_ms, 1),
            "tokens": tokens,
            "stream": stream,
            "error": error[:300] if error else None,
        })

    def list(self) -> list[dict[str, Any]]:
        return list(self._buf)

    def clear(self) -> None:
        self._buf.clear()


request_log = RequestLog(maxlen=100)


class UpstreamError(Exception):
    """Terminal upstream failure after all retries (or unretryable)."""

    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        super().__init__(f"upstream HTTP {status}")


class PoolExhausted(PoolEmpty):
    pass


def _client(proxy_url: Optional[str]) -> httpx.AsyncClient:
    return httpx.AsyncClient(proxy=proxy_url, timeout=REQUEST_TIMEOUT)


def _usage_tokens(usage: Any) -> int:
    if isinstance(usage, dict):
        try:
            return int(usage.get("total_tokens") or 0)
        except (TypeError, ValueError):
            return 0
    return 0


async def chat_completion(
    payload: dict[str, Any],
    pool: KeyPool,
    cooldown_s: int = 60,
    max_retries: int = 3,
) -> dict[str, Any]:
    """Non-streaming chat completion with key/proxy rotation. Returns upstream JSON."""
    tried: set[str] = set()
    last_status, last_body = 502, {"error": {"message": "upstream unavailable"}}
    attempts = max(1, max_retries)
    for attempt in range(attempts):
        try:
            key, proxy_url = await pool.acquire(exclude_key_ids=tried)
        except PoolEmpty:
            if tried and last_status:
                break  # all keys tried -> surface last upstream error
            raise PoolExhausted("pool is empty: add an API key first")
        tried.add(key["id"])
        headers = {"Authorization": f"Bearer {key['key']}", "Content-Type": "application/json"}
        started = time.perf_counter()
        try:
            async with _client(proxy_url) as client:
                resp = await client.post(f"{UPSTREAM_BASE}/chat/completions", json=payload, headers=headers)
            latency_ms = (time.perf_counter() - started) * 1000
        except (httpx.HTTPError, OSError) as exc:
            latency_ms = (time.perf_counter() - started) * 1000
            logger.warning("Network error via key %s proxy %s: %s", key["id"], proxy_url, exc)
            await pool.report_failure(key["id"], proxy_url, str(exc), network_error=True, cooldown_s=cooldown_s)
            request_log.add(model=payload.get("model", ""), key_label=key.get("label", ""),
                            proxy_url=proxy_url, status=None, latency_ms=latency_ms, stream=False,
                            error=str(exc))
            last_status, last_body = 502, {"error": {"message": f"network error: {exc}"}}
            continue
        if resp.status_code == 200:
            try:
                body = resp.json()
            except json.JSONDecodeError:
                await pool.report_failure(key["id"], proxy_url, "invalid JSON from upstream", http_status=502)
                request_log.add(model=payload.get("model", ""), key_label=key.get("label", ""),
                                proxy_url=proxy_url, status=502, latency_ms=latency_ms, stream=False,
                                error="invalid JSON from upstream")
                last_status, last_body = 502, {"error": {"message": "invalid JSON from upstream"}}
                continue
            usage = body.get("usage")
            tokens = _usage_tokens(usage)
            await pool.report_success(key["id"], proxy_url, latency_ms, tokens)
            request_log.add(model=payload.get("model", ""), key_label=key.get("label", ""),
                            proxy_url=proxy_url, status=200, latency_ms=latency_ms, tokens=tokens,
                            stream=False)
            return body
        # HTTP error from upstream
        err_text = resp.text[:1000]
        logger.warning("Upstream HTTP %s (key %s): %s", resp.status_code, key["id"], err_text[:200])
        await pool.report_failure(key["id"], proxy_url, f"HTTP {resp.status_code}: {err_text[:200]}",
                                  http_status=resp.status_code, cooldown_s=cooldown_s)
        request_log.add(model=payload.get("model", ""), key_label=key.get("label", ""),
                        proxy_url=proxy_url, status=resp.status_code, latency_ms=latency_ms, stream=False,
                        error=err_text[:200])
        try:
            last_body = resp.json()
        except json.JSONDecodeError:
            last_body = {"error": {"message": err_text}}
        last_status = resp.status_code
        if resp.status_code not in (401, 429) and resp.status_code < 500:
            break  # 4xx like 400 won't heal by rotating keys
    raise UpstreamError(last_status, last_body)


async def chat_completion_stream(
    payload: dict[str, Any],
    pool: KeyPool,
    cooldown_s: int = 60,
    max_retries: int = 3,
) -> AsyncIterator[str]:
    """Streaming chat completion. Yields raw SSE lines ('data: ...') from upstream.

    Retries with different key/proxy pairs only before the stream has started;
    once upstream answers 200 the stream is passed through transparently.
    """
    tried: set[str] = set()
    last_status, last_body = 502, {"error": {"message": "upstream unavailable"}}
    attempts = max(1, max_retries)
    for attempt in range(attempts):
        try:
            key, proxy_url = await pool.acquire(exclude_key_ids=tried)
        except PoolEmpty:
            if tried and last_status:
                break
            raise PoolExhausted("pool is empty: add an API key first")
        tried.add(key["id"])
        headers = {"Authorization": f"Bearer {key['key']}", "Content-Type": "application/json"}
        started = time.perf_counter()
        client = _client(proxy_url)
        try:
            async with client:
                async with client.stream(
                    "POST", f"{UPSTREAM_BASE}/chat/completions", json=payload, headers=headers
                ) as resp:
                    if resp.status_code != 200:
                        body_text = (await resp.aread()).decode("utf-8", "replace")[:1000]
                        latency_ms = (time.perf_counter() - started) * 1000
                        await pool.report_failure(key["id"], proxy_url, f"HTTP {resp.status_code}: {body_text[:200]}",
                                                  http_status=resp.status_code, cooldown_s=cooldown_s)
                        request_log.add(model=payload.get("model", ""), key_label=key.get("label", ""),
                                        proxy_url=proxy_url, status=resp.status_code, latency_ms=latency_ms,
                                        stream=True, error=body_text[:200])
                        try:
                            last_body = json.loads(body_text)
                        except json.JSONDecodeError:
                            last_body = {"error": {"message": body_text}}
                        last_status = resp.status_code
                        if resp.status_code not in (401, 429) and resp.status_code < 500:
                            break
                        continue
                    # stream established: passthrough
                    tokens = 0
                    first = True
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        if line.startswith("data:"):
                            data_part = line[5:].strip()
                            if data_part and data_part != "[DONE]":
                                try:
                                    chunk = json.loads(data_part)
                                    tokens = max(tokens, _usage_tokens(chunk.get("usage")))
                                except json.JSONDecodeError:
                                    pass
                            yield line
                        else:
                            yield line
                    latency_ms = (time.perf_counter() - started) * 1000
                    await pool.report_success(key["id"], proxy_url, latency_ms, tokens)
                    request_log.add(model=payload.get("model", ""), key_label=key.get("label", ""),
                                    proxy_url=proxy_url, status=200, latency_ms=latency_ms, tokens=tokens,
                                    stream=True)
                    return
        except (httpx.HTTPError, OSError) as exc:
            logger.warning("Network error (stream) via key %s proxy %s: %s", key["id"], proxy_url, exc)
            await pool.report_failure(key["id"], proxy_url, str(exc), network_error=True, cooldown_s=cooldown_s)
            request_log.add(model=payload.get("model", ""), key_label=key.get("label", ""),
                            proxy_url=proxy_url, status=None,
                            latency_ms=(time.perf_counter() - started) * 1000, stream=True, error=str(exc))
            last_status, last_body = 502, {"error": {"message": f"network error: {exc}"}}
            continue
    raise UpstreamError(last_status, last_body)


async def list_models_upstream(api_key: str, proxy_url: Optional[str] = None) -> list[dict[str, Any]]:
    """Fetch model list from upstream with a specific key."""
    headers = {"Authorization": f"Bearer {api_key}"}
    async with _client(proxy_url) as client:
        resp = await client.get(f"{UPSTREAM_BASE}/models", headers=headers)
    resp.raise_for_status()
    data = resp.json()
    return data.get("data", [])


async def test_key(api_key: str, proxy_url: Optional[str]) -> tuple[bool, float, Optional[str]]:
    """POST /api/keys/{id}/test helper: cheap models-list call."""
    started = time.perf_counter()
    try:
        await list_models_upstream(api_key, proxy_url)
        return True, (time.perf_counter() - started) * 1000, None
    except (httpx.HTTPError, OSError) as exc:
        detail = str(exc)
        if isinstance(exc, httpx.HTTPStatusError):
            detail = f"HTTP {exc.response.status_code}"
        return False, (time.perf_counter() - started) * 1000, detail


async def test_proxy(proxy_url: str) -> tuple[bool, float, Optional[str]]:
    """POST /api/proxies/{id}/test helper: reach a public endpoint via proxy."""
    started = time.perf_counter()
    try:
        async with _client(proxy_url) as client:
            resp = await client.get("https://api.ipify.org")
        if resp.status_code == 200:
            return True, (time.perf_counter() - started) * 1000, None
        return False, (time.perf_counter() - started) * 1000, f"HTTP {resp.status_code}"
    except (httpx.HTTPError, OSError) as exc:
        return False, (time.perf_counter() - started) * 1000, str(exc)
