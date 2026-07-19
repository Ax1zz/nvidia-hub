// Таб «Чат»: стриминг через /v1/chat/completions (SSE), история чатов на сервере
// (graceful fallback в память, если /api/chats недоступен), системный промпт,
// перегенерация, экспорт в Markdown.
import { $, icon, toast, store, escapeHtml, plural, fmtInt, fmtDay, copyText, flashCopied, armButton, disarmButton, truncate } from "./util.js";
import { fillModels, getChats, getChat, saveChatApi, renameChatApi, deleteChatApi } from "./api.js";
import { streamSSE } from "./sse.js";
import { renderMarkdown } from "./md.js";
import { attachResizer } from "./resizer.js";

const state = {
  messages: [],          // [{role: "user"|"assistant", content}]
  streaming: false,
  abort: null,
  stick: true,           // автопрокрутка, пока пользователь у нижней кромки
  params: Object.assign(
    { temperature: 0.7, top_p: 1, max_tokens: 2048, system_prompt: "" },
    store.get("nhub:params", {})
  ),
  // история
  chatId: null,
  title: null,
  chatsSupported: true,
  list: [],              // [ChatMeta]
  saveTimer: null,
};

let els = {};

const TYPING_HTML = '<div class="typing"><span></span><span></span><span></span></div>';
const COPY_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const REGEN_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

export function initChat() {
  els = {
    model: $("#chat-model"),
    messages: $("#chat-messages"),
    inner: $("#chat-messages-inner"),
    empty: $("#chat-empty"),
    form: $("#chat-form"),
    input: $("#chat-input"),
    send: $("#chat-send"),
    stop: $("#chat-stop"),
    fresh: $("#chat-new"),
    historyNew: $("#history-new"),
    historyCol: $("#chat-history"),
    historyList: $("#history-list"),
    resizerHistory: $("#resizer-history"),
    resizerParams: $("#resizer-params"),
    export: $("#chat-export"),
    counter: $("#chat-counter"),
    params: $("#chat-params"),
    paramsToggle: $("#chat-params-toggle"),
    sysToggle: $("#sysprompt-toggle"),
    sysBody: $("#sysprompt-body"),
    sysPrompt: $("#p-system-prompt"),
    temp: $("#p-temperature"),
    tempVal: $("#p-temperature-val"),
    topP: $("#p-top-p"),
    topPVal: $("#p-top-p-val"),
    maxTok: $("#p-max-tokens"),
    maxTokVal: $("#p-max-tokens-val"),
    paramsReset: $("#params-reset"),
  };

  fillModels(els.model, store.get("nhub:model"));
  els.model.addEventListener("change", () => {
    store.set("nhub:model", els.model.value);
    scheduleSave();
  });

  // параметры ↔ слайдеры + системный промпт
  bindSlider(els.temp, els.tempVal, "temperature", (v) => v.toFixed(2));
  bindSlider(els.topP, els.topPVal, "top_p", (v) => v.toFixed(2));
  bindSlider(els.maxTok, els.maxTokVal, "max_tokens", (v) => String(Math.round(v)));
  els.paramsReset.addEventListener("click", () => {
    state.params = { temperature: 0.7, top_p: 1, max_tokens: 2048, system_prompt: "" };
    applyParamsToUi();
    store.set("nhub:params", state.params);
    scheduleSave();
  });
  applyParamsToUi();

  els.sysToggle.addEventListener("click", () => {
    els.sysToggle.classList.toggle("open");
    els.sysBody.classList.toggle("hidden");
  });
  els.sysPrompt.addEventListener("input", () => {
    state.params.system_prompt = els.sysPrompt.value;
    store.set("nhub:params", state.params);
    scheduleSave();
  });
  // если промпт уже сохранён — раскрываем блок сразу
  if (state.params.system_prompt) {
    els.sysToggle.classList.add("open");
    els.sysBody.classList.remove("hidden");
  }

  // панель параметров: тоггл + запоминание состояния
  const paramsOpen = store.get("nhub:params-open", true);
  setParamsOpen(paramsOpen, false);
  els.paramsToggle.addEventListener("click", () => setParamsOpen(els.params.classList.contains("closed")));

  // ресайзеры
  attachResizer(els.resizerHistory, els.historyCol, { side: "right", min: 190, max: 420, def: 250, storageKey: "nhub:w:history" });
  attachResizer(els.resizerParams, els.params, { side: "left", min: 230, max: 480, def: 282, storageKey: "nhub:w:params" });

  // ввод
  els.input.addEventListener("input", () => {
    autoresize();
    els.send.disabled = !els.input.value.trim() || state.streaming;
  });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });
  els.form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  els.stop.addEventListener("click", () => state.abort?.abort());
  els.fresh.addEventListener("click", newChat);
  els.historyNew.addEventListener("click", newChat);
  els.export.addEventListener("click", exportChat);

  // действия сообщений (копирование / перегенерация) — делегирование
  els.inner.addEventListener("click", (e) => {
    const btn = e.target.closest(".msg-act");
    if (!btn) return;
    const msgEl = btn.closest(".msg");
    const idx = [...els.inner.children].indexOf(msgEl);
    const m = state.messages[idx];
    if (!m) return;
    if (btn.dataset.act === "copy") {
      copyText(m.content).then((ok) => (ok ? flashCopied(btn) : toast("Не удалось скопировать", "error")));
    } else if (btn.dataset.act === "regen") {
      regenerate();
    }
  });

  // история: делегирование
  els.historyList.addEventListener("click", onHistoryClick);

  // автопрокрутка: следим, только если пользователь внизу
  els.messages.addEventListener("scroll", () => {
    const m = els.messages;
    state.stick = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  });

  // быстрые подсказки в пустом состоянии
  els.empty.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-prompt]");
    if (!chip) return;
    els.input.value = chip.dataset.prompt;
    autoresize();
    els.send.disabled = false;
    els.input.focus();
  });

  updateEmpty();
  updateCounter();
  loadChatList();

  // досохраняем чат при уходе со страницы/смене вкладки
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
}

/* ================= ПАНЕЛЬ ПАРАМЕТРОВ ================= */

function setParamsOpen(open, persist = true) {
  els.params.classList.toggle("closed", !open);
  els.resizerParams.classList.toggle("hidden", !open);
  if (persist) store.set("nhub:params-open", open);
}

function bindSlider(input, badge, key, fmt) {
  input.addEventListener("input", () => {
    state.params[key] = Number(input.value);
    badge.textContent = fmt(state.params[key]);
    store.set("nhub:params", state.params);
    scheduleSave();
  });
}

function applyParamsToUi() {
  els.temp.value = state.params.temperature;
  els.tempVal.textContent = Number(state.params.temperature).toFixed(2);
  els.topP.value = state.params.top_p;
  els.topPVal.textContent = Number(state.params.top_p).toFixed(2);
  els.maxTok.value = state.params.max_tokens;
  els.maxTokVal.textContent = String(state.params.max_tokens);
  els.sysPrompt.value = state.params.system_prompt || "";
  if (state.params.system_prompt) {
    els.sysToggle.classList.add("open");
    els.sysBody.classList.remove("hidden");
  }
}

function autoresize() {
  const t = els.input;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 180) + "px";
}

/* ================= ИСТОРИЯ ЧАТОВ ================= */

async function loadChatList() {
  try {
    const metas = await getChats();
    if (!Array.isArray(metas)) throw new Error("bad format");
    state.chatsSupported = true;
    state.list = metas;
    renderChatList();
  } catch {
    disableHistory();
  }
}

function disableHistory() {
  state.chatsSupported = false;
  els.historyCol.classList.add("hidden");
  els.resizerHistory.classList.add("hidden");
}

function renderChatList() {
  if (!state.list.length) {
    els.historyList.innerHTML = '<div class="history-empty">Пока пусто.<br>Начните диалог — он сохранится здесь.</div>';
    return;
  }
  els.historyList.innerHTML = state.list.map((c) => `
    <div class="history-item${c.id === state.chatId ? " active" : ""}" data-id="${escapeHtml(c.id)}">
      <div class="hi-title">${escapeHtml(c.title || "Новый чат")}</div>
      <div class="hi-meta">${escapeHtml(fmtDay(c.updated_at))} · ${plural(c.message_count ?? 0, "сообщение", "сообщения", "сообщений")}</div>
      <div class="hi-actions">
        <button class="hi-btn" data-action="rename" title="Переименовать">${icon("pencil", 12)}</button>
        <button class="hi-btn danger" data-action="delete" title="Удалить">${icon("trash", 12)}</button>
      </div>
    </div>`).join("");
}

function markActive(id) {
  state.chatId = id;
  els.historyList.querySelectorAll(".history-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
}

async function onHistoryClick(e) {
  const item = e.target.closest(".history-item");
  if (!item) return;
  const id = item.dataset.id;
  const actionBtn = e.target.closest("[data-action]");

  if (actionBtn?.dataset.action === "rename") {
    e.stopPropagation();
    startRename(item, id);
    return;
  }
  if (actionBtn?.dataset.action === "delete") {
    e.stopPropagation();
    if (!armButton(actionBtn, "Точно?")) return;
    try {
      await deleteChatApi(id);
      if (state.chatId === id) newChat();
      await loadChatList();
      toast("Чат удалён", "success", 2000);
    } catch (err) {
      toast("Не удалось удалить: " + err.message, "error");
    }
    return;
  }
  if (e.target.closest(".hi-input")) return; // клик по инпуту переименования
  openChat(id);
}

function startRename(item, id) {
  const meta = state.list.find((c) => c.id === id);
  if (!meta) return;
  const titleEl = item.querySelector(".hi-title");
  const input = document.createElement("input");
  input.className = "input hi-input";
  input.value = meta.title || "";
  input.maxLength = 120;
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (commit && v && v !== meta.title) {
      try {
        await renameChatApi(id, v);
        if (state.chatId === id) state.title = v;
        await loadChatList();
      } catch (err) {
        toast("Не удалось переименовать: " + err.message, "error");
        renderChatList();
      }
    } else {
      renderChatList();
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

async function openChat(id) {
  if (state.chatId === id) return;
  if (state.streaming) state.abort?.abort();
  await flushSave();
  try {
    const chat = await getChat(id);
    state.chatId = chat.id;
    state.title = chat.title || null;
    state.messages = Array.isArray(chat.messages) ? chat.messages.filter((m) => m.role !== "system") : [];
    if (chat.model && [...els.model.options].some((o) => o.value === chat.model)) {
      els.model.value = chat.model;
      store.set("nhub:model", chat.model);
    }
    if (chat.params && typeof chat.params === "object") {
      for (const k of ["temperature", "top_p", "max_tokens", "system_prompt"]) {
        if (chat.params[k] !== undefined) state.params[k] = chat.params[k];
      }
      store.set("nhub:params", state.params);
      applyParamsToUi();
    }
    renderMessages();
    markActive(chat.id);
    state.stick = true;
    scrollKeep(true);
  } catch (err) {
    toast("Не удалось открыть чат: " + err.message, "error");
  }
}

async function newChat() {
  if (state.streaming) state.abort?.abort();
  await flushSave(); // досохранить текущий чат до сброса контекста
  state.chatId = null;
  state.title = null;
  state.messages = [];
  els.inner.innerHTML = "";
  markActive(null);
  updateEmpty();
  updateCounter();
  els.input.focus();
}

function genTitle() {
  const firstUser = state.messages.find((m) => m.role === "user");
  if (!firstUser) return "Новый чат";
  return truncate(firstUser.content.replace(/\s+/g, " ").trim(), 42);
}

function scheduleSave() {
  if (!state.chatsSupported || !state.messages.length) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 800);
}

async function flushSave() {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    await saveNow();
  }
}

async function saveNow() {
  if (!state.chatsSupported || !state.messages.length) return;
  if (!state.title) state.title = genTitle();
  // слепок контекста: ответ применяем, только если контекст за время запроса не сменился
  const sentId = state.chatId;
  const sentMessages = state.messages;
  const body = {
    id: sentId || undefined,
    title: state.title,
    model: els.model.value || undefined,
    params: {
      temperature: state.params.temperature,
      top_p: state.params.top_p,
      max_tokens: state.params.max_tokens,
      system_prompt: state.params.system_prompt || "",
    },
    messages: sentMessages,
  };
  try {
    const chat = await saveChatApi(body);
    if (chat && chat.id && state.chatId === sentId && state.messages === sentMessages) {
      state.chatId = chat.id;
      if (chat.title) state.title = chat.title;
      // мягко обновляем список без сброса скролла
      loadChatList();
    }
  } catch (e) {
    if (/404/.test(e.message)) disableHistory();
    // автосохранение — без тостов, чтобы не спамить
    console.warn("autosave failed:", e.message);
  }
}

/* ================= СООБЩЕНИЯ ================= */

function updateEmpty() {
  els.empty.classList.toggle("hidden", els.inner.children.length > 0);
}

function updateCounter() {
  const n = state.messages.length;
  if (!n) {
    els.counter.textContent = "";
    return;
  }
  const chars = state.messages.reduce((s, m) => s + (m.content?.length || 0), 0);
  els.counter.textContent = `${plural(n, "сообщение", "сообщения", "сообщений")} · ${fmtInt(chars)} символов`;
}

function markLastAssistant() {
  els.inner.querySelectorAll(".msg.is-last-assistant").forEach((el) => el.classList.remove("is-last-assistant"));
  const assistants = els.inner.querySelectorAll(".msg-assistant");
  if (assistants.length) assistants[assistants.length - 1].classList.add("is-last-assistant");
}

function scrollKeep(force = false) {
  if (!state.stick && !force) return;
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setStreaming(on) {
  state.streaming = on;
  els.send.classList.toggle("hidden", on);
  els.stop.classList.toggle("hidden", !on);
  els.send.disabled = !els.input.value.trim() || on;
}

function msgActionsHtml(role) {
  return `<div class="msg-actions">
    <button class="msg-act copy-btn" data-act="copy" title="Копировать сообщение"><span class="ic-copy">${COPY_SVG}</span><span class="ic-check">${CHECK_SVG}</span></button>
    ${role === "assistant" ? `<button class="msg-act" data-act="regen" title="Перегенерировать ответ">${REGEN_SVG}</button>` : ""}
  </div>`;
}

function addMessage(role, content) {
  const msg = document.createElement("div");
  msg.className = `msg msg-${role}`;
  const av = role === "assistant" ? icon("logo", 15, 2.4) : icon("user", 15);
  msg.innerHTML = `<div class="msg-avatar">${av}</div><div class="msg-bubble">${msgActionsHtml(role)}<div class="msg-content markdown"></div></div>`;
  const contentEl = msg.querySelector(".msg-content");
  if (role === "user") {
    contentEl.textContent = content;
  } else {
    contentEl.innerHTML = renderMarkdown(content);
  }
  els.inner.append(msg);
  updateEmpty();
  markLastAssistant();
  scrollKeep(true);
  return msg;
}

function renderMessages() {
  els.inner.innerHTML = "";
  for (const m of state.messages) addMessage(m.role, m.content);
  updateEmpty();
  updateCounter();
  markLastAssistant();
}

// рендер стримящегося текста не чаще одного кадра
function makeStreamRenderer(contentEl) {
  let scheduled = false;
  let latest = "";
  return (text) => {
    latest = text;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      contentEl.innerHTML = renderMarkdown(latest);
      scrollKeep();
    });
  };
}

/* ================= ОТПРАВКА / СТРИМИНГ ================= */

function payloadMessages() {
  const sp = (state.params.system_prompt || "").trim();
  return sp ? [{ role: "system", content: sp }, ...state.messages] : state.messages;
}

async function send() {
  const text = els.input.value.trim();
  if (!text || state.streaming) return;
  if (!els.model.value) {
    toast("Модель не выбрана — список моделей не загружен", "error");
    return;
  }
  els.input.value = "";
  autoresize();
  state.messages.push({ role: "user", content: text });
  addMessage("user", text);
  updateCounter();
  scheduleSave();
  await streamCompletion();
}

async function regenerate() {
  if (state.streaming || !state.messages.length) return;
  const last = state.messages[state.messages.length - 1];
  if (last.role !== "assistant") return;
  state.messages.pop();
  els.inner.lastElementChild?.remove();
  updateEmpty();
  updateCounter();
  markLastAssistant();
  await streamCompletion();
}

async function streamCompletion() {
  if (!els.model.value) {
    toast("Модель не выбрана — список моделей не загружен", "error");
    return;
  }
  setStreaming(true);
  state.stick = true;

  const msg = addMessage("assistant", "");
  msg.classList.add("streaming");
  const contentEl = msg.querySelector(".msg-content");
  contentEl.innerHTML = TYPING_HTML;
  const renderStream = makeStreamRenderer(contentEl);

  const ctrl = new AbortController();
  state.abort = ctrl;
  let acc = "";
  let failed = null;

  try {
    const body = {
      model: els.model.value,
      messages: payloadMessages(),
      stream: true,
      temperature: state.params.temperature,
      top_p: state.params.top_p,
      max_tokens: state.params.max_tokens,
    };
    for await (const data of streamSSE("/v1/chat/completions", body, ctrl.signal)) {
      if (data === "[DONE]") break;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) throw new Error(json.error.message || json.error || "Ошибка прокси");
      const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? "";
      if (delta) {
        acc += delta;
        renderStream(acc);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      acc = acc ? acc + "\n\n*— генерация остановлена*" : "";
    } else {
      failed = e;
    }
  } finally {
    state.abort = null;
    setStreaming(false);
    msg.classList.remove("streaming");
    // финальный рендер (без курсора)
    if (acc) {
      contentEl.innerHTML = renderMarkdown(acc);
      state.messages.push({ role: "assistant", content: acc });
    } else {
      contentEl.innerHTML = "";
    }
    if (failed) {
      const err = document.createElement("div");
      err.className = "msg-error";
      err.textContent = "Ошибка: " + failed.message;
      contentEl.append(err);
      toast(failed.message, "error");
    }
    if (!acc && !failed) {
      contentEl.innerHTML = '<span style="color:var(--faint)">Пустой ответ от модели</span>';
    }
    if (!acc && failed) {
      // пустой пузырь с ошибкой оставляем, но в историю он не попадает
      markLastAssistant();
    }
    updateEmpty();
    updateCounter();
    markLastAssistant();
    scrollKeep(true);
    scheduleSave();
  }
}

/* ================= ЭКСПОРТ ================= */

function exportChat() {
  if (!state.messages.length) {
    toast("Чат пуст — нечего экспортировать", "info");
    return;
  }
  const title = state.title || genTitle();
  const lines = [`# ${title}`, ""];
  lines.push(`Модель: ${els.model.value || "—"}`, `Экспортировано: ${new Date().toLocaleString("ru-RU")}`, "");
  const sp = (state.params.system_prompt || "").trim();
  if (sp) lines.push(`> **Системный промпт:** ${sp}`, "");
  for (const m of state.messages) {
    lines.push(m.role === "user" ? "**Вы:**" : "**Модель:**", "", m.content, "", "---", "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "chat"}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("Чат сохранён в Markdown", "success", 2000);
}
