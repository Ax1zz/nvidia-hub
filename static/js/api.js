// Обёртки над REST API бэкенда (все запросы — same origin)
import { escapeHtml, toast } from "./util.js";

export class ApiError extends Error {}

export async function api(path, { method = "GET", body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new ApiError("Сервер недоступен: " + (e.message || "ошибка сети"));
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail || j.error || j.message || detail;
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch { /* оставляем HTTP-код */ }
    throw new ApiError(detail);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

/* ---------- ключи ---------- */
export const getKeys = () => api("/api/keys");
export const addKey = (key, label, proxyIds) =>
  api("/api/keys", { method: "POST", body: { key, label: label || undefined, proxy_ids: proxyIds } });
export const patchKey = (id, patch) => api(`/api/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
export const deleteKey = (id) => api(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
export const testKey = (id) => api(`/api/keys/${encodeURIComponent(id)}/test`, { method: "POST" });
export const importKeys = (text) => api("/api/keys/import", { method: "POST", body: { text } });

/* ---------- прокси ---------- */
export const getProxies = () => api("/api/proxies");
export const addProxy = (url) => api("/api/proxies", { method: "POST", body: { url } });
export const patchProxy = (id, patch) => api(`/api/proxies/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
export const deleteProxy = (id) => api(`/api/proxies/${encodeURIComponent(id)}`, { method: "DELETE" });
export const testProxy = (id) => api(`/api/proxies/${encodeURIComponent(id)}/test`, { method: "POST" });

/* ---------- статистика ---------- */
export const getStats = () => api("/api/stats");
export const resetStats = () => api("/api/stats/reset", { method: "POST" });

/* ---------- настройки ---------- */
export const getSettings = () => api("/api/settings");
export const patchSettings = (patch) => api("/api/settings", { method: "PATCH", body: patch });

/* ---------- история чатов (contract v2) ---------- */
export const getChats = () => api("/api/chats");
export const getChat = (id) => api(`/api/chats/${encodeURIComponent(id)}`);
export const saveChatApi = (body) => api("/api/chats", { method: "POST", body });
export const renameChatApi = (id, title) =>
  api(`/api/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: { title } });
export const deleteChatApi = (id) => api(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });

/* ---------- лог запросов (contract v2) ---------- */
export const getLogs = () => api("/api/logs");
export const clearLogs = () => api("/api/logs", { method: "DELETE" });

/* ---------- файлы workspace ---------- */
export const listFiles = (path = ".") => api(`/api/files?path=${encodeURIComponent(path)}`);
export const readFile = (path) => api(`/api/file?path=${encodeURIComponent(path)}`);
export const writeFile = (path, content) => api("/api/file", { method: "PUT", body: { path, content } });

/* ---------- модели ---------- */
let modelsPromise = null;
export function getModels(force = false) {
  if (!modelsPromise || force) {
    modelsPromise = api("/api/models").catch((e) => { modelsPromise = null; throw e; });
  }
  return modelsPromise;
}

// все <select> моделей на странице — чтобы refresh обновлял их разом
const modelSelects = new Set();

function fillSelect(select, models, savedId) {
  const ids = new Set(models.map((m) => m.id));
  let html = "";
  // сохраняем прежнее значение, даже если его нет в новом списке
  if (savedId && !ids.has(savedId)) {
    html += `<option value="${escapeHtml(savedId)}">${escapeHtml(savedId)}</option>`;
  }
  html += models
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`)
    .join("");
  select.innerHTML = html;
  if (savedId) select.value = savedId;
}

// Заполняет <select> списком моделей, восстанавливает сохранённый выбор
export async function fillModels(select, savedId) {
  modelSelects.add(select);
  select.innerHTML = '<option value="" disabled selected>Загрузка…</option>';
  try {
    const models = await getModels();
    if (!Array.isArray(models) || !models.length) {
      select.innerHTML = '<option value="" disabled selected>Нет моделей</option>';
      return;
    }
    let pick = savedId && models.some((m) => m.id === savedId) ? savedId : null;
    if (!pick) {
      // если бэкенд отдаёт настройки — пробуем default_model
      try {
        const st = await getSettings();
        if (st.default_model && models.some((m) => m.id === st.default_model)) pick = st.default_model;
      } catch { /* настройки опциональны */ }
    }
    fillSelect(select, models, pick || savedId);
  } catch (e) {
    select.innerHTML = '<option value="" disabled selected>Ошибка загрузки</option>';
    toast("Не удалось загрузить модели: " + e.message, "error");
  }
}

// Принудительное обновление списка с upstream (POST /api/models/refresh),
// затем перезаполнение всех селектов с сохранением текущего выбора
export async function refreshModels() {
  const models = await api("/api/models/refresh", { method: "POST" });
  if (!Array.isArray(models) || !models.length) throw new Error("пустой список моделей");
  modelsPromise = Promise.resolve(models);
  for (const sel of modelSelects) {
    if (sel.isConnected) fillSelect(sel, models, sel.value || undefined);
  }
  return models.length;
}
