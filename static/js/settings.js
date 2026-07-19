// Таб «Настройки»: маршрутизация, модель по умолчанию, сервер
import { $, toast, copyText, flashCopied } from "./util.js";
import { getSettings, patchSettings, fillModels } from "./api.js";

let els = {};
let original = {}; // последний прочитанный с сервера объект настроек

export async function initSettings() {
  els = {
    strategy: $("#set-strategy"),
    maxRetries: $("#set-max-retries"),
    cooldown: $("#set-cooldown"),
    defaultModel: $("#set-default-model"),
    port: $("#set-port"),
    baseUrl: $("#set-base-url"),
    baseUrlCopy: $("#set-base-url-copy"),
    save: $("#settings-save"),
    reset: $("#settings-reset"),
  };

  els.baseUrl.textContent = `${location.origin}/v1`;
  els.baseUrlCopy.addEventListener("click", async () => {
    const ok = await copyText(`${location.origin}/v1`);
    if (ok) flashCopied(els.baseUrlCopy);
    else toast("Не удалось скопировать", "error");
  });

  els.save.addEventListener("click", save);
  els.reset.addEventListener("click", () => load(true));

  // отслеживаем «грязное» состояние формы
  for (const el of [els.strategy, els.maxRetries, els.cooldown, els.defaultModel, els.port]) {
    el.addEventListener("input", updateDirty);
    el.addEventListener("change", updateDirty);
  }

  await load();
  // селект моделей — из общего кэша; предвыбираем default_model с сервера
  await fillModels(els.defaultModel, original.default_model);
  applyToForm(original);
  updateDirty();
}

function applyToForm(s) {
  if (!s) return;
  if (s.strategy) els.strategy.value = s.strategy;
  if (s.max_retries != null) els.maxRetries.value = s.max_retries;
  if (s.cooldown_s != null) els.cooldown.value = s.cooldown_s;
  if (s.port != null) els.port.value = s.port;
  if (s.default_model && [...els.defaultModel.options].some((o) => o.value === s.default_model)) {
    els.defaultModel.value = s.default_model;
  }
}

async function load(showToast = false) {
  els.reset.classList.add("loading");
  try {
    const s = await getSettings();
    original = s && typeof s === "object" ? s : {};
    applyToForm(original);
    updateDirty();
    if (showToast) toast("Настройки перечитаны с сервера", "info", 2000);
  } catch (e) {
    toast("Не удалось загрузить настройки: " + e.message, "error");
  } finally {
    els.reset.classList.remove("loading");
  }
}

function currentForm() {
  return {
    strategy: els.strategy.value,
    max_retries: Number(els.maxRetries.value),
    cooldown_s: Number(els.cooldown.value),
    default_model: els.defaultModel.value || original.default_model,
    port: Number(els.port.value),
  };
}

function collectPatch() {
  const cur = currentForm();
  const patch = {};
  for (const k of Object.keys(cur)) {
    if (cur[k] !== original[k]) patch[k] = cur[k];
  }
  return patch;
}

function updateDirty() {
  els.save.disabled = Object.keys(collectPatch()).length === 0;
}

function valid() {
  const { max_retries, cooldown_s, port } = currentForm();
  if (!Number.isInteger(max_retries) || max_retries < 1 || max_retries > 10) {
    toast("Повторных попыток: целое число от 1 до 10", "error");
    els.maxRetries.focus();
    return false;
  }
  if (!Number.isInteger(cooldown_s) || cooldown_s < 5 || cooldown_s > 3600) {
    toast("Пауза ключа: целое число от 5 до 3600 сек", "error");
    els.cooldown.focus();
    return false;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    toast("Порт: целое число от 1 до 65535", "error");
    els.port.focus();
    return false;
  }
  return true;
}

async function save() {
  if (!valid()) return;
  const patch = collectPatch();
  if (!Object.keys(patch).length) {
    updateDirty();
    return;
  }
  els.save.classList.add("loading");
  try {
    const updated = await patchSettings(patch);
    original = { ...original, ...(updated && typeof updated === "object" ? updated : patch) };
    applyToForm(original);
    updateDirty();
    toast("Настройки сохранены", "success");
    if ("port" in patch) {
      toast("Порт применится после перезапуска сервера", "info", 5000);
    }
  } catch (e) {
    toast("Не удалось сохранить настройки: " + e.message, "error");
  } finally {
    els.save.classList.remove("loading");
  }
}
