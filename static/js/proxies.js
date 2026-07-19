// Таб «Прокси»: список, добавление, тест, свитчи
import { $, toast, icon, escapeHtml, fmtInt, fmtLatency, maskProxyUrl, armButton } from "./util.js";
import { getProxies, addProxy, patchProxy, deleteProxy, testProxy } from "./api.js";

const PROXY_STATUS = {
  active: ["Активен", "st-ok"],
  dead: ["Недоступен", "st-bad"],
  disabled: ["Отключён", "st-off"],
};

let proxies = [];
let els = {};

export function initProxies() {
  els = {
    list: $("#proxies-list"),
    refresh: $("#proxies-refresh"),
    newUrl: $("#new-proxy-url"),
    addSubmit: $("#add-proxy-submit"),
  };

  els.refresh.addEventListener("click", () => reload(true));
  els.addSubmit.addEventListener("click", submitAdd);
  els.newUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAdd();
  });
  els.list.addEventListener("click", onListClick);
  els.list.addEventListener("change", onListChange);

  reload();
}

async function reload(showToast = false) {
  if (!proxies.length) {
    els.list.innerHTML = '<div class="skeleton skel-card" style="height:64px"></div>'.repeat(3);
  }
  els.refresh.classList.add("loading");
  try {
    proxies = await getProxies();
    renderList();
    if (showToast) toast("Список прокси обновлён", "success", 1800);
  } catch (e) {
    els.list.innerHTML = "";
    toast("Не удалось загрузить прокси: " + e.message, "error");
  } finally {
    els.refresh.classList.remove("loading");
  }
}

function badge(status) {
  const [text, cls] = PROXY_STATUS[status] || [status, "st-off"];
  return `<span class="badge ${cls}"><span class="dot"></span>${text}</span>`;
}

function renderList() {
  if (!proxies.length) {
    els.list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${icon("globe", 24, 1.6)}</div>
        <h3>Прокси не добавлены</h3>
        <p>Без прокси запросы идут напрямую. Добавьте прокси в формате http://user:pass@host:port или socks5://host:port.</p>
      </div>`;
    return;
  }
  els.list.innerHTML = proxies.map((p) => {
    const st = p.stats || {};
    const lastErr = st.last_error
      ? `<div class="proxy-last-error">${escapeHtml(st.last_error)}</div>`
      : "";
    return `
    <div class="card proxy-card" data-id="${escapeHtml(p.id)}">
      <div class="proxy-main">
        ${badge(p.status)}
        <code class="proxy-url" title="${escapeHtml(maskProxyUrl(p.url))}">${escapeHtml(maskProxyUrl(p.url))}</code>
      </div>
      <div class="proxy-stats">Запросы <b>${fmtInt(st.requests)}</b> · Ошибки <b>${fmtInt(st.errors)}</b></div>
      <div class="key-actions">
        <label class="switch" title="${p.enabled ? "Отключить" : "Включить"}">
          <input type="checkbox" data-action="toggle" ${p.enabled ? "checked" : ""}>
          <span class="slider"></span>
        </label>
        <button class="btn icon ghost sm" data-action="test" title="Проверить прокси">${icon("zap", 14)}</button>
        <button class="btn icon ghost sm danger-text" data-action="delete" title="Удалить прокси">${icon("trash", 14)}</button>
      </div>
      ${lastErr}
    </div>`;
  }).join("");
}

async function onListClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest(".proxy-card");
  const id = card?.dataset.id;
  if (!id) return;

  if (btn.dataset.action === "test") {
    btn.classList.add("loading");
    try {
      const r = await testProxy(id);
      if (r.ok) toast(`Прокси работает · ${fmtLatency(r.latency_ms)}`, "success");
      else toast("Прокси не отвечает: " + (r.error || "неизвестная ошибка"), "error", 6000);
    } catch (err) {
      toast("Ошибка теста: " + err.message, "error");
    } finally {
      btn.classList.remove("loading");
    }
  }

  if (btn.dataset.action === "delete") {
    if (!armButton(btn, "Точно удалить?")) return;
    card.classList.add("leaving");
    try {
      await deleteProxy(id);
      proxies = proxies.filter((p) => p.id !== id);
      setTimeout(() => { card.remove(); if (!proxies.length) renderList(); }, 220);
      toast("Прокси удалён", "success", 2200);
    } catch (err) {
      card.classList.remove("leaving");
      toast("Не удалось удалить: " + err.message, "error");
    }
  }
}

async function onListChange(e) {
  const input = e.target.closest('input[data-action="toggle"]');
  if (!input) return;
  const card = input.closest(".proxy-card");
  const id = card?.dataset.id;
  const enabled = input.checked;
  try {
    const updated = await patchProxy(id, { enabled });
    const i = proxies.findIndex((p) => p.id === id);
    if (i !== -1) proxies[i] = updated;
    renderList();
    toast(enabled ? "Прокси включён" : "Прокси отключён", "info", 1800);
  } catch (err) {
    input.checked = !enabled;
    toast("Не удалось изменить состояние: " + err.message, "error");
  }
}

async function submitAdd() {
  const url = els.newUrl.value.trim();
  if (!url) {
    toast("Введите URL прокси", "error");
    els.newUrl.focus();
    return;
  }
  els.addSubmit.classList.add("loading");
  try {
    await addProxy(url);
    els.newUrl.value = "";
    toast("Прокси добавлен", "success");
    await reload();
  } catch (e) {
    toast("Не удалось добавить прокси: " + e.message, "error");
  } finally {
    els.addSubmit.classList.remove("loading");
  }
}
