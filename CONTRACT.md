# NVIDIA Hub — контракт между бэкендом и фронтендом

Приложение: пул NVIDIA API-ключей + ротация прокси + OpenAI-совместимый прокси-сервер + веб-UI (чат и coder IDE).

- Бэкенд: FastAPI, порт по умолчанию `8400` (настраивается `PORT` env), сервит `static/` на `/`.
- Upstream: `https://integrate.api.nvidia.com/v1` (OpenAI-совместимый).
- Хранение: `data/config.json` (ключи, прокси, настройки), создаётся автоматически.
- Все относительные пути фронта: фетчить на те же origin (`/api/...`, `/v1/...`).

## Модели данных (JSON)

KeyEntry: `{id: str, label: str, key_masked: str, proxy_ids: [str], enabled: bool, stats: {requests: int, errors: int, tokens: int, avg_latency_ms: float, last_error: str|null, last_used_at: str|null}, status: "active"|"cooldown"|"disabled"}`
ProxyEntry: `{id: str, url: str, enabled: bool, stats: {requests: int, errors: int, last_error: str|null}, status: "active"|"dead"|"disabled"}`

## REST API

- `GET /api/keys` → `[KeyEntry]`
- `POST /api/keys` body `{key: str, label?: str, proxy_ids?: [str]}` → KeyEntry
- `PATCH /api/keys/{id}` body `{label?, enabled?, proxy_ids?}` → KeyEntry
- `DELETE /api/keys/{id}` → `{ok: true}`
- `POST /api/keys/{id}/test` → `{ok: bool, latency_ms: float, error?: str}` (реальный запрос models list или 1-токен chat)
- `GET /api/proxies` → `[ProxyEntry]`
- `POST /api/proxies` body `{url: str}` → ProxyEntry (url вида `http://user:pass@host:port` или `socks5://host:port`)
- `PATCH /api/proxies/{id}` `{enabled?}`; `DELETE /api/proxies/{id}`
- `POST /api/proxies/{id}/test` → `{ok, latency_ms, error?}` (через прокси дёрнуть https://api.ipify.org или integrate.api.nvidia.com)
- `POST /api/keys/import` body `{text: str}` — массовый импорт ключей (по одному на строку) → `{added: int, skipped: int}`
- `GET /api/stats` → `{total_requests, total_tokens, total_errors, keys: [...KeyEntry], uptime_s}`
- `POST /api/stats/reset` → `{ok:true}`
- `GET /api/models` → `[{id, name}]` (кэшированный список с upstream через пул; при недоступности — встроенный дефолтный список)

## OpenAI-совместимый прокси (для внешних тулзов и UI чата)

- `POST /v1/chat/completions` — принимает стандартный OpenAI payload (`model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, ...). Авторизация не требуется (localhost) ИЛИ опциональный токен из настроек. Проксирует на upstream, подставляя ключ из пула (round-robin по enabled-ключам, при 401/429/5xx/сетевой ошибке — следующий ключ/прокси, до N попыток). Поддерживает `stream: true` (SSE passthrough) и не-стрим.
- `GET /v1/models` — OpenAI-формат списка моделей.
- Выбор прокси для запроса: у ключа есть `proxy_ids`; при каждом запросе берётся следующий по кругу enabled-прокси из этого списка (пустой список = прямое соединение).

## Агент (Coder IDE)

- `POST /api/agent/chat` body `{messages: [...], model?: str, workspace_ok?: true}` → **SSE stream** событий (Content-Type: text/event-stream), каждое событие `data: {json}\n\n`:
  - `{type: "text", delta: str}` — потоковый текст ассистента
  - `{type: "tool_start", name: str, args: obj}`
  - `{type: "tool_result", name: str, ok: bool, output: str}` (output усечён до ~4000 символов)
  - `{type: "done"}` / `{type: "error", message: str}`
- Tools (function calling, цикл до 8 итераций): `list_files(path?)`, `read_file(path)`, `write_file(path, content)`, `run_command(command)` (таймаут 30с, cwd=workspace). Все пути ограничены `workspace/` в корне проекта (path traversal запрещён).

## Файлы workspace (для IDE)

- `GET /api/files?path=.` → `[{name, path, type: "file"|"dir", size}]`
- `GET /api/file?path=...` → `{path, content}` (текст, до 1 МБ)
- `PUT /api/file` body `{path, content}` → `{ok:true}`
- Все пути sandboxed в `workspace/`.

## Настройки

- `GET /api/settings` → `{strategy: "round_robin"|"least_used", max_retries: int, cooldown_s: int, default_model: str, port: int}`
- `PATCH /api/settings` — частичное обновление.

## Фронтенд-страницы (одна SPA `static/index.html` + `app.css` + `app.js`)

Табы: **Чат**, **Coder**, **Ключи**, **Прокси**, **Статистика**. Стрим чата — через `fetch` + ReadableStream на `/v1/chat/completions` со `stream:true` (парсинг SSE-строк `data:`), агент — через `/api/agent/chat`. Модели подгружать с `GET /api/models`.
