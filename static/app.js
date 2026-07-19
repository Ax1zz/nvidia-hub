// NVIDIA Hub — точка входа: роутинг табов, глобальные обработчики
import { $, $$, toast, copyText, flashCopied, store } from "./js/util.js";
import { codeStore } from "./js/md.js";
import { refreshModels } from "./js/api.js";
import { initChat } from "./js/chat.js";
import { initCoder } from "./js/coder.js";
import { initKeys } from "./js/keys.js";
import { initProxies } from "./js/proxies.js";
import { initStats, activateStats, deactivateStats } from "./js/stats.js";
import { initSettings } from "./js/settings.js";

const views = {
  chat: { init: initChat },
  coder: { init: initCoder },
  keys: { init: initKeys },
  proxies: { init: initProxies },
  stats: { init: initStats, onActivate: activateStats, onDeactivate: deactivateStats },
  settings: { init: initSettings },
};

const inited = new Set();
let current = null;

function activate(name) {
  if (!views[name] || name === current) return;
  if (current) views[current].onDeactivate?.();

  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));

  current = name;
  store.set("nhub:tab", name);

  if (!inited.has(name)) {
    inited.add(name);
    Promise.resolve(views[name].init()).catch((e) => {
      console.error(e);
      toast("Ошибка инициализации: " + (e?.message || e), "error");
    });
  }
  views[name].onActivate?.();
}

/* ---------- навигация ---------- */
$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => activate(btn.dataset.view));
});

/* ---------- копирование код-блоков (делегирование) ---------- */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-code-id]");
  if (!btn) return;
  const code = codeStore.get(Number(btn.dataset.codeId));
  if (code == null) return;
  const ok = await copyText(code);
  if (ok) flashCopied(btn);
  else toast("Не удалось скопировать", "error");
});

/* ---------- обновление списка моделей (делегирование) ---------- */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".js-models-refresh");
  if (!btn || btn.classList.contains("spin")) return;
  btn.classList.add("spin");
  try {
    const n = await refreshModels();
    toast(`Список моделей обновлён: ${n} шт.`, "success");
  } catch (err) {
    toast("Не удалось обновить — показан кэш (" + err.message + ")", "error");
  } finally {
    btn.classList.remove("spin");
  }
});

/* ---------- глобальные ошибки ---------- */
window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  const msg = e.reason?.message || String(e.reason);
  if (msg && msg !== "AbortError") toast(msg, "error", 5000);
});

/* ---------- старт ---------- */
const savedTab = store.get("nhub:tab", "chat");
activate(views[savedTab] ? savedTab : "chat");
