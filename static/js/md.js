// Лёгкий рендерер markdown: заголовки, списки (с вложенностью), таблицы,
// цитаты, код-блоки с кнопкой копирования и подсветкой через highlight.js (если загружен).
import { escapeHtml, icon } from "./util.js";

// Хранилище сырого кода для кнопок копирования (id → code)
export const codeStore = new Map();
let codeSeq = 0;

function storeCode(code) {
  const id = ++codeSeq;
  codeStore.set(id, code);
  if (codeStore.size > 400) {
    const cutoff = codeSeq - 400;
    for (const k of codeStore.keys()) {
      if (k <= cutoff) codeStore.delete(k);
      else break;
    }
  }
  return id;
}

/* ---------- инлайн-разметка ---------- */
function inline(text) {
  const inlineCodes = [];
  let h = escapeHtml(text);
  // инлайн-код — в плейсхолдеры, чтобы внутри не срабатывали ** и пр.
  h = h.replace(/`([^`\n]+)`/g, (m, code) => {
    inlineCodes.push(code);
    return `\u0001${inlineCodes.length - 1}\u0002`;
  });
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  h = h.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<em>$1</em>");
  h = h.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<em>$1</em>");
  h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  h = h.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+|#[^)\s]*)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  h = h.replace(/\u0001(\d+)\u0002/g, (m, i) => `<code class="inline-code">${inlineCodes[+i]}</code>`);
  return h;
}

/* ---------- блоки ---------- */
function codeBlockHtml(block) {
  const id = storeCode(block.code);
  const lang = (block.lang || "").toLowerCase();
  let inner = escapeHtml(block.code);
  if (lang && window.hljs && window.hljs.getLanguage && window.hljs.getLanguage(lang)) {
    try {
      inner = window.hljs.highlight(block.code, { language: lang, ignoreIllegals: true }).value;
    } catch { /* остаётся экранированный текст */ }
  }
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(lang || "code")}</span>` +
    `<button class="copy-btn btn ghost sm" data-code-id="${id}" title="Копировать код">` +
    `<span class="ic-copy">${icon("copy", 13)} Копировать</span>` +
    `<span class="ic-check">${icon("check", 13, 2)} Готово</span>` +
    `</button></div><pre><code class="hljs">${inner}</code></pre></div>`;
}

const listRe = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const isTableSep = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

function buildList(items) {
  let html = "";
  const stack = []; // {indent, tag}
  let liOpen = false;
  for (const it of items) {
    const tag = it.ordered ? "ol" : "ul";
    if (stack.length === 0) {
      html += `<${tag}>`;
      stack.push({ indent: it.indent, tag });
    } else if (it.indent > stack[stack.length - 1].indent) {
      html += `<${tag}>`; // вложенный список внутри текущего <li>
      stack.push({ indent: it.indent, tag });
    } else {
      if (liOpen) { html += "</li>"; liOpen = false; }
      while (stack.length && it.indent < stack[stack.length - 1].indent) {
        html += `</${stack.pop().tag}>`;
        if (stack.length) html += "</li>"; // закрыть <li>, содержавший вложенный список
      }
      if (stack.length && stack[stack.length - 1].tag !== tag) {
        html += `</${stack.pop().tag}><${tag}>`;
        stack.push({ indent: it.indent, tag });
      }
    }
    html += `<li>${inline(it.text)}`;
    liOpen = true;
  }
  while (stack.length) {
    if (liOpen) { html += "</li>"; liOpen = false; }
    html += `</${stack.pop().tag}>`;
    if (stack.length) html += "</li>";
  }
  return html;
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function tableHtml(header, rows) {
  const th = header.map((c) => `<th>${inline(c)}</th>`).join("");
  const trs = rows
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function isBlockStart(line) {
  return (
    !line.trim() ||
    /^\s*#{1,4}\s/.test(line) ||
    /^\s*([-*_])\1{2,}\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    listRe.test(line) ||
    /^\s*\u0000CODE\d+\u0000\s*$/.test(line)
  );
}

function renderLines(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // код-блок (плейсхолдер)
    const ph = line.trim().match(/^\u0000CODE(\d+)\u0000$/);
    if (ph) { out.push(codeBlockHtml(pendingBlocks[+ph[1]])); i++; continue; }

    // заголовок
    const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++; continue;
    }

    // горизонтальная линия
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    // таблица
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(tableHtml(header, rows));
      continue;
    }

    // цитата
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderLines(q)}</blockquote>`);
      continue;
    }

    // список
    if (listRe.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(listRe);
        if (!m) break;
        items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        i++;
      }
      out.push(buildList(items));
      continue;
    }

    // абзац (склеиваем соседние «мягкие» строки)
    const p = [line];
    while (i + 1 < lines.length && lines[i + 1].trim() && !isBlockStart(lines[i + 1])) {
      // не поглощать начало таблицы: последняя строка абзаца + разделитель
      if (p[p.length - 1].includes("|") && isTableSep(lines[i + 1])) break;
      p.push(lines[++i]);
    }
    i++;
    out.push(`<p>${p.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}

// буфер текущего рендера для плейсхолдеров код-блоков
let pendingBlocks = [];

export function renderMarkdown(src) {
  const raw = String(src ?? "").replace(/\r\n/g, "\n");
  pendingBlocks = [];
  // вырезаем fenced-блоки до любой обработки
  const prepared = raw.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    const id = pendingBlocks.length;
    pendingBlocks.push({ lang: (lang || "").trim(), code: code.replace(/\n$/, "") });
    return `\n\u0000CODE${id}\u0000\n`;
  });
  return renderLines(prepared.split("\n"));
}
