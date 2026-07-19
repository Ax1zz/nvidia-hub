// Таб «Статистика»: дашборд с автообновлением + живой лог запросов
import { $, toast, escapeHtml, fmtInt, fmtLatency, fmtUptime, armButton, truncate } from "./util.js";
import { getStats, resetStats, getLogs, clearLogs } from "./api.js";

const KEY_STATUS = {
  active: ["Активен", "st-ok"],
  cooldown: ["Пауза", "st-warn"],
  disabled: ["Отключён", "st-off"],
};

let els = {};
let timer = null;

export function initStats() {
  els = {
    refresh: $("#stats-refresh"),
    reset: $("#stats-reset"),
    auto: $("#stats-auto"),
    requests: $("#stat-requests"),
    tokens: $("#stat-tokens"),
    errors: $("#stat-errors"),
    uptime: $("#stat-uptime"),
    tbody: $("#stats-tbody"),
    tableWrap: $("#stats-table-wrap"),
    logsTbody: $("#logs-tbody"),
    logsClear: $("#logs-clear"),
  };

  els.refresh.addEventListener("click", () => load(true));
  els.reset.addEventListener("click", async () => {
    if (!armButton(els.reset, "Сбросить статистику?")) return;
    try {
      await resetStats();
      toast("Статистика сброшена", "success");
      await load();
    } catch (e) {
      toast("Не удалось сбросить: " + e.message, "error");
    }
  });
  els.logsClear.addEventListener("click", async () => {
    if (!armButton(els.logsClear, "Очистить лог?")) return;
    try {
      await clearLogs();
      toast("Лог очищен", "success", 2000);
      await load();
    } catch (e) {
      toast("Не удалось очистить лог: " + e.message, "error");
    }
  });
  els.auto.addEventListener("change", schedule);
}

/* вызываются роутером при входе/уходе с таба */
export function activateStats() {
  load();
  schedule();
}

export function deactivateStats() {
  clearInterval(timer);
  timer = null;
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (els.auto.checked) timer = setInterval(load, 5000);
}

function setVal(el, text) {
  if (el.textContent !== text) {
    el.textContent = text;
    el.classList.remove("flash");
    void el.offsetWidth; // перезапуск анимации
    el.classList.add("flash");
  }
}

async function load(showToast = false) {
  els.refresh.classList.add("loading");
  const [statsRes, logsRes] = await Promise.allSettled([getStats(), getLogs()]);
  if (statsRes.status === "fulfilled") {
    const s = statsRes.value;
    setVal(els.requests, fmtInt(s.total_requests));
    setVal(els.tokens, fmtInt(s.total_tokens));
    setVal(els.errors, fmtInt(s.total_errors));
    setVal(els.uptime, fmtUptime(s.uptime_s));
    renderTable(s.keys || []);
    if (showToast) toast("Статистика обновлена", "success", 1500);
  } else {
    toast("Не удалось загрузить статистику: " + statsRes.reason.message, "error");
  }
  if (logsRes.status === "fulfilled" && Array.isArray(logsRes.value)) {
    renderLogs(logsRes.value);
  } else {
    els.logsTbody.innerHTML = '<tr><td colspan="7" class="table-empty">Лог запросов пока недоступен на сервере</td></tr>';
  }
  els.refresh.classList.remove("loading");
}

function badge(status) {
  const [text, cls] = KEY_STATUS[status] || [status, "st-off"];
  return `<span class="badge ${cls}"><span class="dot"></span>${text}</span>`;
}

function renderTable(keys) {
  if (!keys.length) {
    els.tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Нет данных — добавьте ключи</td></tr>';
    return;
  }
  const maxTok = Math.max(1, ...keys.map((k) => k.stats?.tokens || 0));
  els.tbody.innerHTML = keys.map((k) => {
    const st = k.stats || {};
    const w = Math.round(((st.tokens || 0) / maxTok) * 100);
    return `<tr>
      <td class="cell-key">
        <span class="cell-key-name">${escapeHtml(k.label || "Без метки")}</span>
        <span class="cell-key-masked">${escapeHtml(k.key_masked || "")}</span>
      </td>
      <td>${badge(k.status)}</td>
      <td><span class="cell-num">${fmtInt(st.requests)}</span></td>
      <td><span class="cell-num${st.errors ? " err" : ""}">${fmtInt(st.errors)}</span></td>
      <td><span class="cell-num">${fmtInt(st.tokens)}</span><div class="bar"><i style="width:${w}%"></i></div></td>
      <td><span class="cell-num">${fmtLatency(st.avg_latency_ms)}</span></td>
    </tr>`;
  }).join("");
}

/* ---------- лог запросов ---------- */

function logStatus(l) {
  if (l.error) return `<span class="badge st-bad" title="${escapeHtml(l.error)}">Ошибка</span>`;
  const s = l.status;
  if (s == null) return '<span class="badge st-off">—</span>';
  const cls = s < 300 ? "st-ok" : s < 500 ? "st-warn" : "st-bad";
  return `<span class="badge ${cls}">${s}</span>`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("ru-RU");
}

function renderLogs(logs) {
  if (!logs.length) {
    els.logsTbody.innerHTML = '<tr><td colspan="7" class="table-empty">Запросов пока не было</td></tr>';
    return;
  }
  els.logsTbody.innerHTML = logs.map((l) => `<tr>
    <td><span class="cell-num">${escapeHtml(fmtTime(l.ts))}</span></td>
    <td class="cell-model"><span title="${escapeHtml(l.model || "")}">${escapeHtml(truncate(l.model || "—", 34))}</span></td>
    <td class="cell-keylog"><span>${escapeHtml(l.key_label || "—")}</span></td>
    <td class="cell-proxy"><span title="${escapeHtml(l.proxy || "")}">${escapeHtml(truncate(l.proxy || "напрямую", 30))}</span></td>
    <td>${logStatus(l)}</td>
    <td><span class="cell-num">${fmtLatency(l.latency_ms)}</span></td>
    <td><span class="cell-num">${fmtInt(l.tokens)}</span></td>
  </tr>`).join("");
}
