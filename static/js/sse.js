// Парсер SSE-потока (строки "data: ...") поверх fetch + ReadableStream
export async function* streamSSE(path, body, signal) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail || j.error || j.message || detail;
      if (typeof detail !== "string") detail = JSON.stringify(detail);
    } catch { /* оставляем HTTP-код */ }
    throw new Error(detail);
  }
  if (!res.body) throw new Error("Браузер не поддерживает потоковое чтение");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) yield line.slice(5).replace(/^ /, "");
        }
      }
    }
    buf += dec.decode();
    if (buf.trim()) {
      for (const line of buf.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).replace(/^ /, "");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
