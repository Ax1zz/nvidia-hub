// DOM-хелперы, форматирование, тосты, иконки

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6.5 8-6.5s8 2.5 8 6.5"/>',
  logo: '<path d="M7 20V4l10 16V4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  key: '<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
};

export function icon(name, size = 18, sw = 1.8) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

/* ---------- форматирование ---------- */

const numFmt = new Intl.NumberFormat("ru-RU");
export const fmtInt = (n) => numFmt.format(n ?? 0);

export function fmtLatency(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms <= 0) return "—";
  return ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(2)} с`;
}

export function fmtUptime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}д ${h}ч`;
  if (h) return `${h}ч ${m}м`;
  if (m) return `${m}м ${s % 60}с`;
  return `${s}с`;
}

// Маскирует пароль в URL прокси: http://user:pass@host → http://user:•••@host
export function maskProxyUrl(url) {
  return String(url ?? "").replace(/^([a-z0-9]+:\/\/)([^:@/\s]+):([^@]*)@(.+)$/i, "$1$2:•••@$4");
}

export function truncate(s, n = 60) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Русская плюрализация: plural(2, "сообщение", "сообщения", "сообщений") → "2 сообщения"
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word = many;
  if (mod10 === 1 && mod100 !== 11) word = one;
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = few;
  return `${fmtInt(n)} ${word}`;
}

// Компактная дата для списков: «12 июл» / «12 июл 14:32» (сегодня)
export function fmtDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const day = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
  if (sameDay) return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return day;
}

/* ---------- тосты ---------- */

export function toast(message, type = "info", ms = 4200) {
  const root = $("#toasts");
  if (!root) return;
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  const ic = type === "success" ? "check" : type === "error" ? "alert" : "info";
  t.innerHTML = `<span class="toast-icon">${icon(ic, 16, 2)}</span>` +
    `<span class="toast-msg">${escapeHtml(message)}</span>` +
    `<button class="toast-close" aria-label="Закрыть">${icon("x", 13, 2)}</button>`;
  const close = () => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 280);
  };
  t.querySelector(".toast-close").addEventListener("click", close);
  root.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(close, ms);
}

/* ---------- копирование ---------- */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* noop */ }
    ta.remove();
    return ok;
  }
}

// Анимация кнопки копирования: меняет иконку на галочку
export function flashCopied(btn, ms = 1600) {
  btn.classList.add("copied");
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => btn.classList.remove("copied"), ms);
}

/* ---------- подтверждение по повторному клику ---------- */
// Первый клик «вооружает» кнопку, второй — выполняет. Возвращает true, если можно выполнять.
export function armButton(btn, armedText = "Подтвердить?", timeout = 2600) {
  if (btn.classList.contains("armed")) {
    disarmButton(btn);
    return true;
  }
  btn.dataset.origHtml = btn.innerHTML;
  btn.classList.add("armed");
  btn.innerHTML = `<span style="font-size:12px">${escapeHtml(armedText)}</span>`;
  btn._armTimer = setTimeout(() => disarmButton(btn), timeout);
  return false;
}

export function disarmButton(btn) {
  clearTimeout(btn._armTimer);
  btn.classList.remove("armed");
  if (btn.dataset.origHtml) {
    btn.innerHTML = btn.dataset.origHtml;
    delete btn.dataset.origHtml;
  }
}

/* ---------- localStorage с запасным вариантом ---------- */
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* noop */ }
  },
};
