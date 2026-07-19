"""Coder agent: function calling loop over the same key pool, SSE events out."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from .config import WORKSPACE_DIR
from .pool import KeyPool, PoolEmpty
from . import upstream

logger = logging.getLogger("nvidia_hub.agent")

MAX_ITERATIONS = 8
TOOL_OUTPUT_LIMIT = 4000
COMMAND_TIMEOUT_S = 30

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files and directories at a path inside the workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Relative path, default '.'"}},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file from the workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write (create/overwrite) a text file in the workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run a shell command in the workspace (30s timeout).",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
]


def sandbox_path(rel: str) -> Path:
    """Resolve rel inside workspace; raise on traversal."""
    base = WORKSPACE_DIR.resolve()
    target = (base / rel).resolve()
    if target != base and base not in target.parents:
        raise PermissionError(f"path escapes workspace: {rel}")
    return target


def _trunc(s: str, limit: int = TOOL_OUTPUT_LIMIT) -> str:
    return s if len(s) <= limit else s[:limit] + f"\n... [truncated, {len(s)} chars total]"


async def _tool_list_files(path: str = ".") -> str:
    target = sandbox_path(path or ".")
    if not target.is_dir():
        return f"error: not a directory: {path}"
    lines = []
    for entry in sorted(target.iterdir()):
        kind = "dir" if entry.is_dir() else "file"
        size = "-" if entry.is_dir() else str(entry.stat().st_size)
        lines.append(f"{kind}\t{size}\t{entry.name}")
    return "\n".join(lines) or "(empty)"


async def _tool_read_file(path: str) -> str:
    target = sandbox_path(path)
    if not target.is_file():
        return f"error: no such file: {path}"
    if target.stat().st_size > 1024 * 1024:
        return "error: file too large (>1MB)"
    return target.read_text(encoding="utf-8", errors="replace")


async def _tool_write_file(path: str, content: str) -> str:
    target = sandbox_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"ok: wrote {len(content)} chars to {path}"


async def _tool_run_command(command: str) -> str:
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(WORKSPACE_DIR),
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=COMMAND_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return f"error: command timed out after {COMMAND_TIMEOUT_S}s"
    text = out.decode("utf-8", "replace")
    return f"exit={proc.returncode}\n{text}"


async def execute_tool(name: str, args: dict[str, Any]) -> tuple[bool, str]:
    try:
        if name == "list_files":
            return True, _trunc(await _tool_list_files(str(args.get("path", "."))))
        if name == "read_file":
            return True, _trunc(await _tool_read_file(str(args.get("path", ""))))
        if name == "write_file":
            return True, _trunc(await _tool_write_file(str(args.get("path", "")), str(args.get("content", ""))))
        if name == "run_command":
            return True, _trunc(await _tool_run_command(str(args.get("command", ""))))
        return False, f"error: unknown tool: {name}"
    except PermissionError as exc:
        return False, f"error: {exc}"
    except Exception as exc:  # tools must never crash the agent loop
        logger.exception("tool %s failed", name)
        return False, f"error: {type(exc).__name__}: {exc}"


def _merge_tool_calls(acc: dict[int, dict[str, Any]], deltas: list[dict[str, Any]]) -> None:
    for d in deltas:
        idx = d.get("index", 0)
        slot = acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
        if d.get("id"):
            slot["id"] = d["id"]
        fn = d.get("function") or {}
        if fn.get("name"):
            slot["name"] = fn["name"]
        if fn.get("arguments"):
            slot["arguments"] += fn["arguments"]


async def run_agent(
    messages: list[dict[str, Any]],
    model: str,
    pool: KeyPool,
    cooldown_s: int,
    max_retries: int,
) -> AsyncIterator[dict[str, Any]]:
    """Yield SSE event dicts: text / tool_start / tool_result / done / error."""
    history = list(messages)
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    for iteration in range(MAX_ITERATIONS):
        payload = {
            "model": model,
            "messages": history,
            "tools": TOOLS,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        text_parts: list[str] = []
        tool_calls: dict[int, dict[str, Any]] = {}
        finish_reason: Optional[str] = None
        try:
            async for line in upstream.chat_completion_stream(payload, pool, cooldown_s, max_retries):
                if not line.startswith("data:"):
                    continue
                data_part = line[5:].strip()
                if not data_part or data_part == "[DONE]":
                    continue
                try:
                    chunk = json.loads(data_part)
                except json.JSONDecodeError:
                    continue
                for choice in chunk.get("choices", []):
                    delta = choice.get("delta") or {}
                    if delta.get("content"):
                        text_parts.append(delta["content"])
                        yield {"type": "text", "delta": delta["content"]}
                    if delta.get("tool_calls"):
                        _merge_tool_calls(tool_calls, delta["tool_calls"])
                    if choice.get("finish_reason"):
                        finish_reason = choice["finish_reason"]
        except PoolEmpty:
            yield {"type": "error", "message": "Пул ключей пуст — добавьте API-ключ на вкладке «Ключи»."}
            return
        except upstream.UpstreamError as exc:
            yield {"type": "error", "message": f"upstream error {exc.status}: {json.dumps(exc.body)[:300]}"}
            return
        except Exception as exc:
            logger.exception("agent iteration failed")
            yield {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
            return

        calls = [tool_calls[i] for i in sorted(tool_calls)] if tool_calls else []
        if not calls:
            # final answer
            if not text_parts:
                yield {"type": "text", "delta": "(модель вернула пустой ответ)"}
            yield {"type": "done"}
            return

        # record assistant message with tool calls
        history.append({
            "role": "assistant",
            "content": "".join(text_parts) or None,
            "tool_calls": [
                {
                    "id": c["id"] or f"call_{i}",
                    "type": "function",
                    "function": {"name": c["name"], "arguments": c["arguments"] or "{}"},
                }
                for i, c in enumerate(calls)
            ],
        })
        for i, c in enumerate(calls):
            call_id = c["id"] or f"call_{i}"
            try:
                args = json.loads(c["arguments"]) if c["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
                ok, output = False, f"error: bad tool arguments JSON: {c['arguments'][:200]}"
                yield {"type": "tool_start", "name": c["name"], "args": args}
                yield {"type": "tool_result", "name": c["name"], "ok": ok, "output": output}
                history.append({"role": "tool", "tool_call_id": call_id, "content": output})
                continue
            yield {"type": "tool_start", "name": c["name"], "args": args}
            ok, output = await execute_tool(c["name"], args)
            yield {"type": "tool_result", "name": c["name"], "ok": ok, "output": output}
            history.append({"role": "tool", "tool_call_id": call_id, "content": output})
    yield {"type": "error", "message": f"превышен лимит итераций агента ({MAX_ITERATIONS})"}
