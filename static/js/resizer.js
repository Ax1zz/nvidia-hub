// Универсальный drag-resizer для панелей: mousedown → mousemove → mouseup,
// подсветка полосы, двойной клик — сброс к дефолту, ширина persist в localStorage.
import { store } from "./util.js";

export function attachResizer(handle, target, opts = {}) {
  const {
    side = "right",   // "right" — target слева от полосы (dx вправо = шире); "left" — target справа
    min = 160,
    max = 620,
    def = 260,
    storageKey = null,
    onResize = null,
  } = opts;
  if (!handle || !target) return;

  const clamp = (w) => Math.max(min, Math.min(max, w));

  if (storageKey) {
    const saved = Number(store.get(storageKey));
    if (saved) target.style.width = clamp(saved) + "px";
  }

  let startX = 0;
  let startW = 0;

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = target.offsetWidth;
    handle.classList.add("dragging");
    document.body.classList.add("resizing");

    const onMove = (e2) => {
      const dx = e2.clientX - startX;
      const w = clamp(side === "right" ? startW + dx : startW - dx);
      target.style.width = w + "px";
      onResize?.(w);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      if (storageKey) store.set(storageKey, target.offsetWidth);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  handle.addEventListener("dblclick", () => {
    target.style.width = def + "px";
    onResize?.(def);
    if (storageKey) store.set(storageKey, def);
  });
}
