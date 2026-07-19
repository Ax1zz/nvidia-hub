// Таб «Coder»: дерево файлов workspace, редактор с табами, панель агента (SSE-события)
import { $, icon, toast, store, escapeHtml, truncate } from "./util.js";
import { listFiles, readFile, writeFile, fillModels } from "./api.js";
import { streamSSE } from "./sse.js";
import { renderMarkdown } from "./md.js";
import { attachResizer } from "./resizer.js";

/* ---------- состояние ---------- */
const openFiles = new Map(); // path → { content, dirty }
let activePath = null;
let previewOn = false;
let toolSeq = 0;

const agent = {
  messages: [],
  streaming: false,
  abort: null,
  stick: true,
};

let els = {};

const EXT_LANG = {
  js: "javascript", mjs: "javascript", ts: "typescript", py: "python", json: "json",
  md: "markdown", css: "css", html: "html", xml: "xml", sh: "bash", bash: "bash",
  yml: "yaml", yaml: "yaml", rs: "rust", go: "go", c: "c", h: "c", cpp: "cpp",
  java: "java", sql: "sql", toml: "ini", ini: "ini", txt: "plaintext",
};

export function initCoder() {
  els = {
    tree: $("#file-tree"),
    refresh: $("#files-refresh"),
    tabs: $("#editor-tabs"),
    editorEmpty: $("#editor-empty"),
    editorWrap: $("#editor-wrap"),
    editorPath: $("#editor-path"),
    textarea: $("#editor-textarea"),
    preview: $("#editor-preview"),
    previewCode: $("#editor-preview-code"),
    previewToggle: $("#editor-preview-toggle"),
    save: $("#editor-save"),
    agentModel: $("#agent-model"),
    agentMessages: $("#agent-messages"),
    agentEmpty: $("#agent-empty"),
    agentForm: $("#agent-form"),
    agentInput: $("#agent-input"),
    agentSend: $("#agent-send"),
    agentStop: $("#agent-stop"),
  };

  fillModels(els.agentModel, store.get("nhub:agent-model"));
  els.agentModel.addEventListener("change", () => store.set("nhub:agent-model", els.agentModel.value));

  // ресайзеры между колонками
  attachResizer($("#resizer-files"), $(".files-col"), { side: "right", min: 170, max: 420, def: 232, storageKey: "nhub:w:files" });
  attachResizer($("#resizer-agent"), $(".agent-col"), { side: "left", min: 280, max: 560, def: 350, storageKey: "nhub:w:agent" });

  els.refresh.addEventListener("click", () => loadTree(true));
  loadTree();

  // делегирование по дереву
  els.tree.addEventListener("click", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    if (row.dataset.type === "dir") toggleDir(row);
    else openFile(row.dataset.path);
  });

  // табы редактора
  els.tabs.addEventListener("click", (e) => {
    const close = e.target.closest(".etab-close");
    const tab = e.target.closest(".etab");
    if (close && tab) {
      e.stopPropagation();
      closeTab(tab.dataset.path);
      return;
    }
    if (tab) activateTab(tab.dataset.path);
  });

  els.textarea.addEventListener("input", () => {
    const f = openFiles.get(activePath);
    if (!f) return;
    f.content = els.textarea.value;
    if (!f.dirty) { f.dirty = true; renderTabs(); updateSaveBtn(); }
  });
  els.textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveActive();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const t = e.target;
      const { selectionStart: s, selectionEnd: en, value } = t;
      t.value = value.slice(0, s) + "  " + value.slice(en);
      t.selectionStart = t.selectionEnd = s + 2;
      t.dispatchEvent(new Event("input"));
    }
  });

  els.save.addEventListener("click", saveActive);
  els.previewToggle.addEventListener("click", togglePreview);

  // агент
  els.agentForm.addEventListener("submit", (e) => { e.preventDefault(); sendAgent(); });
  els.agentStop.addEventListener("click", () => agent.abort?.abort());
  els.agentInput.addEventListener("input", () => {
    agentAutoresize();
    els.agentSend.disabled = !els.agentInput.value.trim() || agent.streaming;
  });
  els.agentInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      els.agentForm.requestSubmit();
    }
  });
  els.agentMessages.addEventListener("scroll", () => {
    const m = els.agentMessages;
    agent.stick = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  });
  els.agentEmpty.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-agent-prompt]");
    if (!chip) return;
    els.agentInput.value = chip.dataset.agentPrompt;
    agentAutoresize();
    els.agentSend.disabled = false;
    els.agentInput.focus();
  });
}

/* ================= ДЕРЕВО ФАЙЛОВ ================= */

async function loadTree(showToast = false) {
  els.tree.innerHTML = '<div class="skeleton skel-row"></div>'.repeat(6);
  els.refresh.classList.add("loading");
  try {
    const items = await listFiles(".");
    els.tree.innerHTML = renderNodes(sortItems(items), 0);
    if (!items.length) {
      els.tree.innerHTML = '<div class="table-empty">Workspace пуст</div>';
    }
    if (showToast) toast("Список файлов обновлён", "success", 1800);
  } catch (e) {
    els.tree.innerHTML = `<div class="table-empty">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
    toast(e.message, "error");
  } finally {
    els.refresh.classList.remove("loading");
  }
}

const sortItems = (items) =>
  [...items].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, "ru") : a.type === "dir" ? -1 : 1
  );

function renderNodes(items, depth) {
  return items.map((n) => {
    const isDir = n.type === "dir";
    return `<div class="tree-node">
      <button class="tree-row" data-path="${escapeHtml(n.path)}" data-type="${n.type}" data-depth="${depth}" title="${escapeHtml(n.path)}">
        <span style="width:${depth * 13}px;flex-shrink:0"></span>
        <span class="tree-chev">${isDir ? icon("chevron", 11, 2) : ""}</span>
        <span class="tree-icon">${icon(isDir ? "folder" : "file", 13)}</span>
        <span class="tree-name">${escapeHtml(n.name)}</span>
      </button>
      ${isDir ? '<div class="tree-children hidden"></div>' : ""}
    </div>`;
  }).join("");
}

async function toggleDir(row) {
  const children = row.parentElement.querySelector(".tree-children");
  if (!children) return;
  const isOpen = row.classList.contains("open");
  if (isOpen) {
    row.classList.remove("open");
    children.classList.add("hidden");
    return;
  }
  row.classList.add("open");
  children.classList.remove("hidden");
  if (children.dataset.loaded) return;
  children.innerHTML = '<div class="skeleton skel-row"></div>';
  try {
    const items = await listFiles(row.dataset.path);
    children.dataset.loaded = "1";
    const level = Number(row.dataset.depth || 0) + 1;
    children.innerHTML = items.length
      ? renderNodes(sortItems(items), level)
      : '<div class="table-empty" style="padding:8px 10px;text-align:left">пусто</div>';
  } catch (e) {
    children.innerHTML = `<div class="table-empty" style="padding:8px 10px;text-align:left">${escapeHtml(e.message)}</div>`;
  }
}

/* ================= РЕДАКТОР ================= */

async function openFile(path) {
  if (openFiles.has(path)) { activateTab(path); return; }
  try {
    const f = await readFile(path);
    openFiles.set(path, { content: f.content ?? "", dirty: false });
    renderTabs();
    activateTab(path);
  } catch (e) {
    toast("Не удалось открыть файл: " + e.message, "error");
  }
}

function renderTabs() {
  els.tabs.innerHTML = [...openFiles.entries()].map(([path, f]) => {
    const name = path.split("/").pop();
    return `<div class="etab${path === activePath ? " active" : ""}" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">
      <span>${escapeHtml(name)}</span>
      ${f.dirty ? '<span class="dirty-dot" title="Есть несохранённые изменения"></span>' : ""}
      <button class="etab-close" title="Закрыть">×</button>
    </div>`;
  }).join("");
  // подсветка активного файла в дереве
  els.tree.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
  if (activePath) {
    const row = els.tree.querySelector(`.tree-row[data-path="${CSS.escape(activePath)}"]`);
    row?.classList.add("active");
  }
}

function activateTab(path) {
  const f = openFiles.get(path);
  if (!f) return;
  activePath = path;
  els.editorEmpty.classList.add("hidden");
  els.editorWrap.classList.remove("hidden");
  els.editorPath.textContent = path;
  if (previewOn) {
    renderPreview();
  } else {
    els.textarea.value = f.content;
  }
  renderTabs();
  updateSaveBtn();
}

function closeTab(path) {
  const f = openFiles.get(path);
  if (f?.dirty) {
    if (!confirm(`Файл «${path}» не сохранён. Закрыть без сохранения?`)) return;
  }
  openFiles.delete(path);
  if (activePath === path) {
    const rest = [...openFiles.keys()];
    if (rest.length) activateTab(rest[rest.length - 1]);
    else {
      activePath = null;
      els.editorWrap.classList.add("hidden");
      els.editorEmpty.classList.remove("hidden");
    }
  }
  renderTabs();
}

function updateSaveBtn() {
  els.save.disabled = !openFiles.get(activePath)?.dirty;
}

async function saveActive() {
  const f = openFiles.get(activePath);
  if (!f || !f.dirty) return;
  els.save.classList.add("loading");
  try {
    await writeFile(activePath, els.textarea.value);
    f.content = els.textarea.value;
    f.dirty = false;
    renderTabs();
    updateSaveBtn();
    toast(`Сохранено: ${activePath}`, "success", 2200);
  } catch (e) {
    toast("Ошибка сохранения: " + e.message, "error");
  } finally {
    els.save.classList.remove("loading");
  }
}

function togglePreview() {
  previewOn = !previewOn;
  els.previewToggle.classList.toggle("active", previewOn);
  els.textarea.classList.toggle("hidden", previewOn);
  els.preview.classList.toggle("hidden", !previewOn);
  if (previewOn) renderPreview();
}

function renderPreview() {
  const f = openFiles.get(activePath);
  if (!f) return;
  const content = els.textarea.value;
  const ext = (activePath.split(".").pop() || "").toLowerCase();
  const lang = EXT_LANG[ext];
  let html = escapeHtml(content);
  if (lang && window.hljs?.getLanguage?.(lang)) {
    try {
      html = window.hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
    } catch { /* без подсветки */ }
  }
  els.previewCode.innerHTML = html;
}

/* ================= АГЕНТ ================= */

function agentAutoresize() {
  const t = els.agentInput;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 140) + "px";
}

function agentScrollKeep(force = false) {
  if (!agent.stick && !force) return;
  els.agentMessages.scrollTop = els.agentMessages.scrollHeight;
}

function agentUpdateEmpty() {
  const has = els.agentMessages.querySelector(".msg, .tool-card");
  els.agentEmpty.classList.toggle("hidden", !!has);
}

function agentSetStreaming(on) {
  agent.streaming = on;
  els.agentSend.classList.toggle("hidden", on);
  els.agentStop.classList.toggle("hidden", !on);
  els.agentSend.disabled = !els.agentInput.value.trim() || on;
}

function agentAddMsg(role, content) {
  const msg = document.createElement("div");
  msg.className = `msg msg-${role}`;
  const av = role === "assistant" ? icon("logo", 15, 2.4) : icon("user", 15);
  msg.innerHTML = `<div class="msg-avatar">${av}</div><div class="msg-bubble"><div class="msg-content markdown"></div></div>`;
  const contentEl = msg.querySelector(".msg-content");
  if (role === "user") contentEl.textContent = content;
  else contentEl.innerHTML = renderMarkdown(content);
  els.agentMessages.append(msg);
  agentUpdateEmpty();
  agentScrollKeep(true);
  return msg;
}

function addToolCard(ev) {
  const id = ++toolSeq;
  const card = document.createElement("div");
  card.className = "tool-card";
  card.dataset.toolId = String(id);
  const argsStr = truncate(JSON.stringify(ev.args ?? {}), 90);
  card.innerHTML = `
    <button class="tool-head">
      <span class="tool-dot running"></span>
      <span class="tool-name">${escapeHtml(ev.name || "tool")}</span>
      <span class="tool-args">${escapeHtml(argsStr)}</span>
      <span class="tool-chev">${icon("chevronDown", 13)}</span>
    </button>
    <div class="tool-body hidden">
      <div><div class="tool-label">Аргументы</div><pre class="tool-args-full"></pre></div>
      <div class="tool-result-sec hidden"><div class="tool-label">Результат</div><pre class="tool-output"></pre></div>
    </div>`;
  card.querySelector(".tool-args-full").textContent = JSON.stringify(ev.args ?? {}, null, 2);
  card.querySelector(".tool-head").addEventListener("click", () => {
    card.classList.toggle("expanded");
    card.querySelector(".tool-body").classList.toggle("hidden");
  });
  els.agentMessages.append(card);
  agentUpdateEmpty();
  agentScrollKeep(true);
  return id;
}

function fillToolCard(id, ev) {
  const card = els.agentMessages.querySelector(`.tool-card[data-tool-id="${id}"]`);
  if (!card) return;
  const dot = card.querySelector(".tool-dot");
  dot.className = `tool-dot ${ev.ok ? "ok" : "fail"}`;
  card.classList.add(ev.ok ? "succeeded" : "failed");
  card.querySelector(".tool-result-sec").classList.remove("hidden");
  card.querySelector(".tool-output").textContent = ev.output ?? "";
  if (!ev.ok) { // ошибки разворачиваем сразу
    card.classList.add("expanded");
    card.querySelector(".tool-body").classList.remove("hidden");
  }
  agentScrollKeep();
}

function makeAgentStreamRenderer(contentEl) {
  let scheduled = false;
  let latest = "";
  return (text) => {
    latest = text;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      contentEl.innerHTML = renderMarkdown(latest);
      agentScrollKeep();
    });
  };
}

async function sendAgent() {
  const text = els.agentInput.value.trim();
  if (!text || agent.streaming) return;
  if (!els.agentModel.value) {
    toast("Модель агента не выбрана", "error");
    return;
  }
  els.agentInput.value = "";
  agentAutoresize();
  agent.messages.push({ role: "user", content: text });
  agentAddMsg("user", text);
  agentSetStreaming(true);
  agent.stick = true;

  const ctrl = new AbortController();
  agent.abort = ctrl;

  let textEl = null;       // текущий стримящийся пузырь
  let renderStream = null;
  let acc = "";            // текст текущего пузыря
  let accAll = "";         // весь текст ответа (для истории сообщений)
  let failed = null;
  let lastToolId = null;

  const ensureTextBubble = () => {
    if (textEl) return;
    const msg = agentAddMsg("assistant", "");
    msg.classList.add("streaming");
    textEl = msg.querySelector(".msg-content");
    textEl.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    renderStream = makeAgentStreamRenderer(textEl);
  };

  try {
    const body = { messages: agent.messages, model: els.agentModel.value, workspace_ok: true };
    for await (const data of streamSSE("/api/agent/chat", body, ctrl.signal)) {
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "text") {
        ensureTextBubble();
        acc += ev.delta || "";
        accAll += ev.delta || "";
        renderStream(acc);
      } else if (ev.type === "tool_start") {
        // завершаем текущий текстовый пузырь перед карточкой инструмента
        if (textEl) {
          textEl.closest(".msg").classList.remove("streaming");
          if (acc) textEl.innerHTML = renderMarkdown(acc);
          textEl = null;
          acc = "";
        }
        lastToolId = addToolCard(ev);
      } else if (ev.type === "tool_result") {
        fillToolCard(lastToolId, ev);
      } else if (ev.type === "done") {
        break;
      } else if (ev.type === "error") {
        throw new Error(ev.message || "Ошибка агента");
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      // помечаем незавершённые инструменты как отменённые
      els.agentMessages.querySelectorAll(".tool-dot.running").forEach((d) => {
        d.className = "tool-dot cancelled";
      });
      if (textEl && !acc) {
        textEl.closest(".msg").remove();
        textEl = null;
      }
    } else {
      failed = e;
    }
  } finally {
    agent.abort = null;
    agentSetStreaming(false);
    agentUpdateEmpty();
    if (textEl) {
      textEl.closest(".msg").classList.remove("streaming");
      if (acc) textEl.innerHTML = renderMarkdown(acc);
    }
    if (accAll) agent.messages.push({ role: "assistant", content: accAll });
    if (failed) {
      const msg = agentAddMsg("assistant", "");
      const err = document.createElement("div");
      err.className = "msg-error";
      err.textContent = "Ошибка: " + failed.message;
      msg.querySelector(".msg-content").append(err);
      toast(failed.message, "error");
    }
    agentScrollKeep(true);
  }
}
