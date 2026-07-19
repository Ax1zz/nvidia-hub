"""FastAPI app: REST API, OpenAI-compatible proxy, agent SSE, static files."""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agent as agent_mod
from . import upstream
from .chats import ChatStore
from .config import STATIC_DIR, ConfigStore, new_key_entry, new_proxy_entry
from .pool import KeyPool, PoolEmpty, public_key_view, public_proxy_view

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("nvidia_hub.main")

DEFAULT_MODELS = [
    "z-ai/glm-4.7",
    "deepseek-ai/deepseek-v3.1-terminus",
    "meta/llama-3.3-70b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "qwen/qwen3-next-80b-a3b-instruct",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "moonshotai/kimi-k2-instruct",
    "mistralai/mistral-large-3-675b-instruct-2512",
]

START_TIME = time.time()

store = ConfigStore()
pool = KeyPool(store)
chats = ChatStore()
app = FastAPI(title="NVIDIA Hub")

_models_cache: dict[str, Any] = {"fetched_at": 0.0, "models": []}
MODELS_CACHE_TTL = 300.0


# ---------- helpers ----------

def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _error_body(message: str, code: str = "server_error") -> dict[str, Any]:
    return {"error": {"message": message, "type": code}}


async def _get_models(force_refresh: bool = False) -> list[str]:
    """Model ids: cached upstream list via pool, fallback to built-in defaults."""
    now = time.time()
    if not force_refresh and _models_cache["models"] and now - _models_cache["fetched_at"] < MODELS_CACHE_TTL:
        return list(_models_cache["models"])
    try:
        key, proxy_url = await pool.acquire()
    except PoolEmpty:
        return list(DEFAULT_MODELS)
    try:
        items = await upstream.list_models_upstream(key["key"], proxy_url)
        ids = sorted({m.get("id") for m in items if m.get("id")})
        if ids:
            _models_cache["models"] = ids
            _models_cache["fetched_at"] = now
            return ids
    except Exception as exc:
        logger.warning("model list fetch failed: %s", exc)
    return list(DEFAULT_MODELS)


async def _settings_and_cooldown() -> tuple[dict[str, Any], int, int]:
    settings = await store.get_settings()
    return settings, int(settings.get("cooldown_s", 60)), int(settings.get("max_retries", 3))


def _find_or_404(items: list[dict[str, Any]], item_id: str, what: str) -> dict[str, Any]:
    for it in items:
        if it["id"] == item_id:
            return it
    raise HTTPException(status_code=404, detail=_error_body(f"{what} not found", "not_found"))


# ---------- request schemas ----------

class KeyCreate(BaseModel):
    key: str
    label: Optional[str] = None
    proxy_ids: Optional[list[str]] = None


class KeyPatch(BaseModel):
    label: Optional[str] = None
    enabled: Optional[bool] = None
    proxy_ids: Optional[list[str]] = None


class ProxyCreate(BaseModel):
    url: str


class ProxyPatch(BaseModel):
    enabled: Optional[bool] = None


class KeysImport(BaseModel):
    text: str


class SettingsPatch(BaseModel):
    strategy: Optional[str] = None
    max_retries: Optional[int] = None
    cooldown_s: Optional[int] = None
    default_model: Optional[str] = None
    port: Optional[int] = None


class AgentChat(BaseModel):
    messages: list[dict[str, Any]]
    model: Optional[str] = None
    workspace_ok: Optional[bool] = None


class FileWrite(BaseModel):
    path: str
    content: str


class ChatUpsert(BaseModel):
    id: Optional[str] = None
    title: Optional[str] = None
    model: Optional[str] = None
    params: Optional[dict[str, Any]] = None
    messages: Optional[list[dict[str, Any]]] = None


class ChatRename(BaseModel):
    title: str


# ---------- keys API ----------

@app.get("/api/keys")
async def list_keys() -> list[dict[str, Any]]:
    snap = await store.snapshot()
    return [public_key_view(k) for k in snap["keys"]]


@app.post("/api/keys")
async def add_key(body: KeyCreate) -> dict[str, Any]:
    key = body.key.strip()
    if not key:
        raise HTTPException(400, _error_body("key is empty", "bad_request"))

    def _do(data: dict[str, Any]) -> dict[str, Any]:
        if any(k["key"] == key for k in data["keys"]):
            raise HTTPException(409, _error_body("key already exists", "conflict"))
        entry = new_key_entry(key, body.label or "", body.proxy_ids or [])
        data["keys"].append(entry)
        return entry

    entry = await store.mutate(_do)
    return public_key_view(entry)


@app.patch("/api/keys/{key_id}")
async def patch_key(key_id: str, body: KeyPatch) -> dict[str, Any]:
    def _do(data: dict[str, Any]) -> dict[str, Any]:
        entry = _find_or_404(data["keys"], key_id, "key")
        if body.label is not None:
            entry["label"] = body.label
        if body.enabled is not None:
            entry["enabled"] = body.enabled
            if body.enabled:
                entry["status"] = "active"
                entry["cooldown_until"] = None
            else:
                entry["status"] = "disabled"
        if body.proxy_ids is not None:
            entry["proxy_ids"] = list(body.proxy_ids)
            entry["proxy_cursor"] = 0
        return entry

    entry = await store.mutate(_do)
    return public_key_view(entry)


@app.delete("/api/keys/{key_id}")
async def delete_key(key_id: str) -> dict[str, Any]:
    def _do(data: dict[str, Any]) -> None:
        entry = _find_or_404(data["keys"], key_id, "key")
        data["keys"].remove(entry)

    await store.mutate(_do)
    return {"ok": True}


@app.post("/api/keys/{key_id}/test")
async def test_key_endpoint(key_id: str) -> dict[str, Any]:
    try:
        key, proxy_url = await pool.acquire_specific(key_id)
    except KeyError:
        raise HTTPException(404, _error_body("key not found", "not_found"))
    ok, latency_ms, error = await upstream.test_key(key["key"], proxy_url)
    return {"ok": ok, "latency_ms": round(latency_ms, 1), **({"error": error} if error else {})}


@app.post("/api/keys/import")
async def import_keys(body: KeysImport) -> dict[str, Any]:
    lines = [ln.strip() for ln in body.text.splitlines()]
    candidates = [ln for ln in lines if ln and not ln.startswith("#")]

    def _do(data: dict[str, Any]) -> dict[str, int]:
        existing = {k["key"] for k in data["keys"]}
        added = skipped = 0
        for key in candidates:
            if key in existing:
                skipped += 1
                continue
            data["keys"].append(new_key_entry(key))
            existing.add(key)
            added += 1
        return {"added": added, "skipped": skipped}

    return await store.mutate(_do)


# ---------- proxies API ----------

@app.get("/api/proxies")
async def list_proxies() -> list[dict[str, Any]]:
    snap = await store.snapshot()
    return [public_proxy_view(p) for p in snap["proxies"]]


@app.post("/api/proxies")
async def add_proxy(body: ProxyCreate) -> dict[str, Any]:
    url = body.url.strip()
    if not (url.startswith("http://") or url.startswith("https://") or url.startswith("socks5://") or url.startswith("socks5h://")):
        raise HTTPException(400, _error_body("url must be http://, https:// or socks5://...", "bad_request"))

    def _do(data: dict[str, Any]) -> dict[str, Any]:
        if any(p["url"] == url for p in data["proxies"]):
            raise HTTPException(409, _error_body("proxy already exists", "conflict"))
        entry = new_proxy_entry(url)
        data["proxies"].append(entry)
        return entry

    entry = await store.mutate(_do)
    return public_proxy_view(entry)


@app.patch("/api/proxies/{proxy_id}")
async def patch_proxy(proxy_id: str, body: ProxyPatch) -> dict[str, Any]:
    def _do(data: dict[str, Any]) -> dict[str, Any]:
        entry = _find_or_404(data["proxies"], proxy_id, "proxy")
        if body.enabled is not None:
            entry["enabled"] = body.enabled
            entry["status"] = "active" if body.enabled else "disabled"
        return entry

    entry = await store.mutate(_do)
    return public_proxy_view(entry)


@app.delete("/api/proxies/{proxy_id}")
async def delete_proxy(proxy_id: str) -> dict[str, Any]:
    def _do(data: dict[str, Any]) -> None:
        entry = _find_or_404(data["proxies"], proxy_id, "proxy")
        data["proxies"].remove(entry)
        for k in data["keys"]:
            if proxy_id in k.get("proxy_ids", []):
                k["proxy_ids"] = [pid for pid in k["proxy_ids"] if pid != proxy_id]
                k["proxy_cursor"] = 0

    await store.mutate(_do)
    return {"ok": True}


@app.post("/api/proxies/{proxy_id}/test")
async def test_proxy_endpoint(proxy_id: str) -> dict[str, Any]:
    snap = await store.snapshot()
    entry = _find_or_404(snap["proxies"], proxy_id, "proxy")
    ok, latency_ms, error = await upstream.test_proxy(entry["url"])
    if not ok:
        def _mark(data: dict[str, Any]) -> None:
            for p in data["proxies"]:
                if p["id"] == proxy_id:
                    p["status"] = "dead"
                    p["stats"]["errors"] += 1
                    p["stats"]["last_error"] = (error or "test failed")[:500]
        await store.mutate(_mark, save=False)
    return {"ok": ok, "latency_ms": round(latency_ms, 1), **({"error": error} if error else {})}


# ---------- stats / settings / models ----------

@app.get("/api/stats")
async def get_stats() -> dict[str, Any]:
    snap = await store.snapshot()
    keys = [public_key_view(k) for k in snap["keys"]]
    return {
        "total_requests": sum(k["stats"]["requests"] for k in keys),
        "total_tokens": sum(k["stats"]["tokens"] for k in keys),
        "total_errors": sum(k["stats"]["errors"] for k in keys),
        "keys": keys,
        "uptime_s": round(time.time() - START_TIME, 1),
    }


@app.post("/api/stats/reset")
async def reset_stats() -> dict[str, Any]:
    def _do(data: dict[str, Any]) -> None:
        for k in data["keys"]:
            k["stats"] = {"requests": 0, "errors": 0, "tokens": 0,
                          "avg_latency_ms": 0.0, "last_error": None, "last_used_at": None}
        for p in data["proxies"]:
            p["stats"] = {"requests": 0, "errors": 0, "last_error": None}

    await store.mutate(_do)
    return {"ok": True}


@app.get("/api/settings")
async def get_settings() -> dict[str, Any]:
    return await store.get_settings()


@app.patch("/api/settings")
async def patch_settings(body: SettingsPatch) -> dict[str, Any]:
    patch = body.model_dump(exclude_none=True)
    if "strategy" in patch and patch["strategy"] not in ("round_robin", "least_used"):
        raise HTTPException(400, _error_body("strategy must be round_robin or least_used", "bad_request"))
    return await store.patch_settings(patch)


@app.get("/api/models")
async def list_models() -> list[dict[str, str]]:
    ids = await _get_models()
    return [{"id": m, "name": m} for m in ids]


@app.post("/api/models/refresh")
async def refresh_models() -> list[dict[str, str]]:
    """Force cache reset and re-fetch from upstream; falls back to cache/defaults."""
    _models_cache["fetched_at"] = 0.0
    ids = await _get_models(force_refresh=True)
    return [{"id": m, "name": m} for m in ids]


# ---------- request logs API ----------

@app.get("/api/logs")
async def get_logs() -> list[dict[str, Any]]:
    return upstream.request_log.list()


@app.delete("/api/logs")
async def clear_logs() -> dict[str, Any]:
    upstream.request_log.clear()
    return {"ok": True}


# ---------- chats API ----------

@app.get("/api/chats")
async def list_chats() -> list[dict[str, Any]]:
    return await chats.list_meta()


@app.post("/api/chats")
async def upsert_chat(body: ChatUpsert) -> dict[str, Any]:
    chat = await chats.upsert(body.model_dump(exclude_none=True))
    return chat


@app.get("/api/chats/{chat_id}")
async def get_chat(chat_id: str) -> dict[str, Any]:
    chat = await chats.get(chat_id)
    if not chat:
        raise HTTPException(404, _error_body("chat not found", "not_found"))
    return chat


@app.patch("/api/chats/{chat_id}")
async def rename_chat(chat_id: str, body: ChatRename) -> dict[str, Any]:
    chat = await chats.rename(chat_id, body.title)
    if not chat:
        raise HTTPException(404, _error_body("chat not found", "not_found"))
    return chat


@app.delete("/api/chats/{chat_id}")
async def delete_chat(chat_id: str) -> dict[str, Any]:
    await chats.delete(chat_id)
    return {"ok": True}


# ---------- workspace files API ----------

@app.get("/api/files")
async def list_files(path: str = Query(".")) -> list[dict[str, Any]]:
    try:
        target = agent_mod.sandbox_path(path)
    except PermissionError as exc:
        raise HTTPException(403, _error_body(str(exc), "forbidden"))
    if not target.is_dir():
        raise HTTPException(404, _error_body("not a directory", "not_found"))
    out = []
    for entry in sorted(target.iterdir()):
        rel = str(entry.relative_to(agent_mod.WORKSPACE_DIR.resolve()))
        out.append({
            "name": entry.name,
            "path": rel,
            "type": "dir" if entry.is_dir() else "file",
            "size": 0 if entry.is_dir() else entry.stat().st_size,
        })
    return out


@app.get("/api/file")
async def read_file(path: str = Query(...)) -> dict[str, str]:
    try:
        target = agent_mod.sandbox_path(path)
    except PermissionError as exc:
        raise HTTPException(403, _error_body(str(exc), "forbidden"))
    if not target.is_file():
        raise HTTPException(404, _error_body("file not found", "not_found"))
    if target.stat().st_size > 1024 * 1024:
        raise HTTPException(413, _error_body("file too large (>1MB)", "too_large"))
    return {"path": path, "content": target.read_text(encoding="utf-8", errors="replace")}


@app.put("/api/file")
async def write_file(body: FileWrite) -> dict[str, Any]:
    try:
        target = agent_mod.sandbox_path(body.path)
    except PermissionError as exc:
        raise HTTPException(403, _error_body(str(exc), "forbidden"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return {"ok": True}


# ---------- agent SSE ----------

@app.post("/api/agent/chat")
async def agent_chat(body: AgentChat) -> StreamingResponse:
    settings, cooldown_s, max_retries = await _settings_and_cooldown()
    model = body.model or settings.get("default_model") or DEFAULT_MODELS[0]

    async def gen():
        async for event in agent_mod.run_agent(body.messages, model, pool, cooldown_s, max_retries):
            yield _sse(event)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- OpenAI-compatible proxy ----------

@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Any:
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(400, _error_body("invalid JSON body", "bad_request"))
    settings, cooldown_s, max_retries = await _settings_and_cooldown()
    if not payload.get("model"):
        payload["model"] = settings.get("default_model") or DEFAULT_MODELS[0]
    stream = bool(payload.get("stream"))

    if not stream:
        try:
            body = await upstream.chat_completion(payload, pool, cooldown_s, max_retries)
            return JSONResponse(body)
        except PoolEmpty as exc:
            return JSONResponse(_error_body(str(exc), "pool_empty"), status_code=503)
        except upstream.UpstreamError as exc:
            return JSONResponse(exc.body if isinstance(exc.body, dict) else _error_body(str(exc.body)),
                                status_code=exc.status)

    async def gen():
        try:
            async for line in upstream.chat_completion_stream(payload, pool, cooldown_s, max_retries):
                yield line + "\n"
        except PoolEmpty as exc:
            yield _sse(_error_body(str(exc), "pool_empty"))
            yield "data: [DONE]\n"
        except upstream.UpstreamError as exc:
            yield _sse(exc.body if isinstance(exc.body, dict) else _error_body(str(exc.body)))
            yield "data: [DONE]\n"
        except Exception as exc:
            logger.exception("stream failed")
            yield _sse(_error_body(f"{type(exc).__name__}: {exc}"))
            yield "data: [DONE]\n"

    # On pool exhaustion before any attempt we still stream an SSE error (OpenAI-style for streams),
    # but if there are simply no keys at all, answer 503 right away for clarity.
    snap = await store.snapshot()
    if not any(k.get("enabled", True) for k in snap["keys"]):
        return JSONResponse(_error_body("pool is empty: add an API key first", "pool_empty"), status_code=503)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/v1/models")
async def openai_models() -> dict[str, Any]:
    ids = await _get_models()
    return {
        "object": "list",
        "data": [{"id": m, "object": "model", "created": 0, "owned_by": "nvidia"} for m in ids],
    }


# ---------- static (must be mounted last) ----------

if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PORT", "8400"))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
