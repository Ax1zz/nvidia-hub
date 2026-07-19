// Таб «Ключи»: список ключей, добавление, массовый импорт, тест, свитчи
import { $, toast, icon, escapeHtml, fmtInt, fmtLatency, maskProxyUrl, copyText, flashCopied, armButton } from "./util.js";
import { getKeys, addKey, patchKey, deleteKey, testKey, importKeys, getProxies } from "./api.js";

const KEY_STATUS = {
  active: ["Активен", "st-ok"],
  cooldown: ["Пауза", "st-warn"],
  disabled: ["Отключён", "st-off"],
};

let keys = [];
let proxies = [];
let els = {};

export async function initKeys() {
  els = {
    list: $("#keys-list"),
    refresh: $("#keys-refresh"),
    addToggle: $("#keys-add-toggle"),
    importToggle: $("#keys-import-toggle"),
    addForm: $("#key-add-form"),
    importForm: $("#key-import-form"),
    newKey: $("#new-key"),
    newLabel: $("#new-key-label"),
    newProxies: $("#new-key-proxies"),
    addSubmit: $("#add-key-submit"),
    addCancel: $("#add-key-cancel"),
    importText: $("#import-text"),
    importSubmit: $("#import-submit"),
    importCancel: $("#import-cancel"),
    endpointUrl: $("#endpoint-url"),
    endpointCopy: $("#endpoint-copy"),
  };

  els.endpointUrl.textContent = `${location.origin}/v1`;
  els.endpointCopy.addEventListener("click", async () => {
    const ok = await copyText(`${location.origin}/v1`);
    if (ok) flashCopied(els.endpointCopy);
    else toast("Не удалось скопировать", "error");
  });

  els.refresh.addEventListener("click", () => reload(true));
  els.addToggle.addEventListener("click", () => {
    els.addForm.classList.toggle("hidden");
    els.newKey.focus();
  });
  els.importToggle.addEventListener("click", () => {
    els.importForm.classList.toggle("hidden");
    els.importText.focus();
  });
  els.addCancel.addEventListener("click", () => els.addForm.classList.add("hidden"));
  els.importCancel.addEventListener("click", () => els.importForm.classList.add("hidden"));
  els.addSubmit.addEventListener("click", submitAdd);
  els.importSubmit.addEventListener("click", submitImport);

  // делегирование действий по карточкам
  els.list.addEventListener("click", onListClick);
  els.list.addEventListener("change", onListChange);

  await reload();
}

async function reload(showToast = false) {
  if (!keys.length) {
    els.list.innerHTML = '<div class="skeleton skel-card"></div>'.repeat(3);
  }
  els.refresh.classList.add("loading");
  try {
    [keys, proxies] = await Promise.all([getKeys(), getProxies()]);
    renderList();
    renderProxyChecks();
    if (showToast) toast("Список ключей обновлён", "success", 1800);
  } catch (e) {
    els.list.innerHTML = "";
    toast("Не удалось загрузить ключи: " + e.message, "error");
  } finally {
    els.refresh.classList.remove("loading");
  }
}

function proxyName(id) {
  const p = proxies.find((x) => x.id === id);
  return p ? maskProxyUrl(p.url) : "неизвестный прокси";
}

function badge(status) {
  const [text, cls] = KEY_STATUS[status] || [status, "st-off"];
  return `<span class="badge ${cls}"><span class="dot"></span>${text}</span>`;
}

function renderList() {
  if (!keys.length) {
    els.list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${icon("key", 24, 1.6)}</div>
        <h3>Ключей пока нет</h3>
        <p>Добавьте первый ключ NVIDIA API — по кнопке выше или массовым импортом.</p>
      </div>`;
    return;
  }
  els.list.innerHTML = keys.map((k) => {
    const st = k.stats || {};
    const proxyChips = (k.proxy_ids || []).length
      ? k.proxy_ids.map((id) => `<span class="proxy-chip" title="${escapeHtml(proxyName(id))}">${escapeHtml(proxyName(id))}</span>`).join("")
      : '<span class="proxy-chip dim">Прямое соединение</span>';
    const lastErr = st.last_error
      ? `<div class="key-last-error">${icon("alert", 13, 2)}<span>${escapeHtml(st.last_error)}</span></div>`
      : "";
    return `
    <div class="card key-card" data-id="${escapeHtml(k.id)}">
      <div class="key-head">
        <div class="key-title">
          <span class="key-label">${escapeHtml(k.label || "Без метки")}</span>
          ${badge(k.status)}
        </div>
        <code class="key-masked">${escapeHtml(k.key_masked || "")}</code>
      </div>
      <div class="key-stats">
        <div class="stat-block"><span class="sb-val">${fmtInt(st.requests)}</span><span class="sb-label">Запросы</span></div>
        <div class="stat-block"><span class="sb-val${st.errors ? " err" : ""}">${fmtInt(st.errors)}</span><span class="sb-label">Ошибки</span></div>
        <div class="stat-block"><span class="sb-val">${fmtInt(st.tokens)}</span><span class="sb-label">Токены</span></div>
        <div class="stat-block"><span class="sb-val">${fmtLatency(st.avg_latency_ms)}</span><span class="sb-label">Ср. задержка</span></div>
      </div>
      ${lastErr}
      <div class="key-foot">
        <div class="key-proxies">${proxyChips}</div>
        <div class="key-actions">
          <label class="switch" title="${k.enabled ? "Отключить" : "Включить"}">
            <input type="checkbox" data-action="toggle" ${k.enabled ? "checked" : ""}>
            <span class="slider"></span>
          </label>
          <button class="btn icon ghost sm" data-action="test" title="Проверить ключ">${icon("zap", 14)}</button>
          <button class="btn icon ghost sm danger-text" data-action="delete" title="Удалить ключ">${icon("trash", 14)}</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

async function onListClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest(".key-card");
  const id = card?.dataset.id;
  if (!id) return;

  if (btn.dataset.action === "test") {
    btn.classList.add("loading");
    try {
      const r = await testKey(id);
      if (r.ok) toast(`Ключ работает · ${fmtLatency(r.latency_ms)}`, "success");
      else toast("Ключ не прошёл проверку: " + (r.error || "неизвестная ошибка"), "error", 6000);
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
      await deleteKey(id);
      keys = keys.filter((k) => k.id !== id);
      setTimeout(() => { card.remove(); if (!keys.length) renderList(); }, 220);
      toast("Ключ удалён", "success", 2200);
    } catch (err) {
      card.classList.remove("leaving");
      toast("Не удалось удалить: " + err.message, "error");
    }
  }
}

async function onListChange(e) {
  const input = e.target.closest('input[data-action="toggle"]');
  if (!input) return;
  const card = input.closest(".key-card");
  const id = card?.dataset.id;
  const enabled = input.checked;
  try {
    const updated = await patchKey(id, { enabled });
    const i = keys.findIndex((k) => k.id === id);
    if (i !== -1) keys[i] = updated;
    // статус мог измениться (disabled/active) — перерисуем карточку
    renderList();
    toast(enabled ? "Ключ включён" : "Ключ отключён", "info", 1800);
  } catch (err) {
    input.checked = !enabled;
    toast("Не удалось изменить состояние: " + err.message, "error");
  }
}

/* ---------- форма добавления ---------- */

function renderProxyChecks() {
  if (!proxies.length) {
    els.newProxies.innerHTML = '<div class="proxy-checks-empty">Прокси не добавлены — ключ будет ходить напрямую.</div>';
    return;
  }
  els.newProxies.innerHTML = proxies.map((p) => `
    <label class="proxy-check">
      <input type="checkbox" value="${escapeHtml(p.id)}">
      <span>${escapeHtml(maskProxyUrl(p.url))}</span>
    </label>`).join("");
  els.newProxies.querySelectorAll("input").forEach((cb) => {
    cb.addEventListener("change", () => cb.closest(".proxy-check").classList.toggle("checked", cb.checked));
  });
}

async function submitAdd() {
  const key = els.newKey.value.trim();
  if (!key) {
    toast("Введите ключ", "error");
    els.newKey.focus();
    return;
  }
  const label = els.newLabel.value.trim();
  const proxyIds = [...els.newProxies.querySelectorAll("input:checked")].map((c) => c.value);
  els.addSubmit.classList.add("loading");
  try {
    await addKey(key, label, proxyIds);
    els.newKey.value = "";
    els.newLabel.value = "";
    els.newProxies.querySelectorAll("input:checked").forEach((c) => {
      c.checked = false;
      c.closest(".proxy-check").classList.remove("checked");
    });
    els.addForm.classList.add("hidden");
    toast("Ключ добавлен", "success");
    await reload();
  } catch (e) {
    toast("Не удалось добавить ключ: " + e.message, "error");
  } finally {
    els.addSubmit.classList.remove("loading");
  }
}

async function submitImport() {
  const text = els.importText.value.trim();
  if (!text) {
    toast("Вставьте ключи — по одному на строку", "error");
    return;
  }
  els.importSubmit.classList.add("loading");
  try {
    const r = await importKeys(text);
    els.importText.value = "";
    els.importForm.classList.add("hidden");
    toast(`Импорт завершён: добавлено ${fmtInt(r.added)}, пропущено ${fmtInt(r.skipped)}`, "success", 5000);
    await reload();
  } catch (e) {
    toast("Ошибка импорта: " + e.message, "error");
  } finally {
    els.importSubmit.classList.remove("loading");
  }
}
