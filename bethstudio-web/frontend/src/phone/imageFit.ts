// Imagem anexada no celular: quando reduzir e regravar antes de subir.
// Puras (tests/phoneImage.test.ts).

export const MAX_SIDE = 2560;
export const MAX_KEEP_BYTES = 900 * 1024;
export const SENDABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Cabe em MAX_SIDE mantendo a proporção. */
export function fitSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const big = Math.max(w, h);
  if (big <= max) return { w, h };
  const k = max / big;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * Sobe o arquivo como está só se o PC aceita o tipo e ele é leve. Foto de
 * câmera (HEIC, 12 MP) e print grande são regravados em JPEG menor: o
 * proxy do servidor pode limitar o tamanho do envio.
 */
export function needsReencode(type: string, bytes: number, w: number, h: number): boolean {
  if (!SENDABLE.includes(type.toLowerCase())) return true;
  if (type.toLowerCase() === "image/gif") return false;
  return bytes > MAX_KEEP_BYTES || Math.max(w, h) > MAX_SIDE;
}

/**
 * Imagens de um colar (clipboardData). Teclados como o Gboard colam um print
 * como arquivo; texto puro não tem arquivo e segue para o campo.
 */
export function pastedImages(data: {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
  files?: ArrayLike<File> | null;
}): File[] {
  const out: File[] = [];
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.toLowerCase().startsWith("image/")) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (out.length) return out;
  return data.files ? Array.from(data.files).filter((f) => f.type.toLowerCase().startsWith("image/")) : [];
}
