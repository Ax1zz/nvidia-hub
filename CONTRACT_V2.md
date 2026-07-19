# CONTRACT v2 — дополнения к CONTRACT.md (всё из CONTRACT.md остаётся в силе)

## История чатов (персистентность на сервере, файл data/chats.json)

ChatMeta: `{id: str, title: str, model: str, created_at: str(iso), updated_at: str(iso), message_count: int}`
Chat (полный): `{id, title, model, params: {temperature: float, top_p: float, max_tokens: int, system_prompt: str}, messages: [{role, content}], created_at, updated_at}`

- `GET /api/chats` → `[ChatMeta]` (сортировка по updated_at desc)
- `POST /api/chats` body `{id?: str, title?: str, model?: str, params?: obj, messages?: []}` → Chat. Upsert: если id передан и существует — полная замена (сохранить created_at, обновить updated_at); если id не передан — создать (сгенерировать id hex12, title по умолчанию "Новый чат").
- `GET /api/chats/{id}` → Chat (404 если нет)
- `PATCH /api/chats/{id}` body `{title: str}` → Chat
- `DELETE /api/chats/{id}` → `{ok: true}`
- Ограничения: до 200 чатов (самые старые по updated_at удаляются), messages до 500 на чат, атомарная запись, тот же asyncio-lock подход, что и config.

## Живой лог запросов прокси

- Ring buffer на 100 последних запросов, проходящих через `/v1/chat/completions` (и агента).
- `GET /api/logs` → `[{ts: str(iso), model: str, key_label: str, proxy: str|null (url с замаскированным паролем user:•••@), status: int|null, latency_ms: float, tokens: int, stream: bool, error: str|null}]` — newest first.
- `DELETE /api/logs` → `{ok:true}`.
- Лог только в памяти (на диск не писать).

## Обновление списка моделей

- `POST /api/models/refresh` → `[{id, name}]` — принудительно сбросить кэш и перетянуть список с upstream (через пул). Если upstream недоступен — вернуть текущий кэш/дефолт, НО с HTTP 200 и полем-маркером нельзя — формат массива сохранить; фронт сам сравнит количество.
