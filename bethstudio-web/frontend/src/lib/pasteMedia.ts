// Colar/soltar imagens e arquivos no terminal (como a GUI: a imagem vira
// PNG em C:\tmp\bethstudio\clipboard-images e o terminal recebe
// ![image](caminho)). O Go salva e cola; aqui so' escolhemos o que enviar.

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];
export const MAX_PASTE_BYTES = 25 * 1024 * 1024;

export interface UploadPlan {
  endpoint: "/api/paste-image" | "/api/paste-file";
  contentType: string;
  name: string;
}

/** Como enviar um arquivo: imagem conhecida -> paste-image; resto -> copia. */
export function planUpload(file: { type: string; name: string; size: number }): UploadPlan | { error: string } {
  if (file.size > MAX_PASTE_BYTES) return { error: `${file.name || "arquivo"} passa de 25 MB` };
  if (file.size === 0) return { error: `${file.name || "arquivo"} está vazio` };
  const t = (file.type || "").toLowerCase();
  if (IMAGE_TYPES.includes(t)) return { endpoint: "/api/paste-image", contentType: t, name: file.name };
  return { endpoint: "/api/paste-file", contentType: "application/octet-stream", name: file.name || "arquivo" };
}

type ClipItem = { kind: string; type: string; getAsFile: () => File | null };

/** Arquivos colados (pdf, video, imagem, qualquer tipo). Itens primeiro; se nao houver, a lista files. */
export function filesFromTransfer(data: { items?: ArrayLike<ClipItem> | null; files?: ArrayLike<File> | null }): File[] {
  const items = data.items;
  const out: File[] = [];
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (out.length) return out;
  return data.files ? Array.from(data.files) : [];
}

/** Primeira imagem de um clipboardData / dataTransfer (itens do tipo image/*). */
export function imageFromItems(items: ArrayLike<ClipItem>): File | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file" && IMAGE_TYPES.includes(it.type.toLowerCase())) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

export function uploadURL(plan: UploadPlan, pane: number): string {
  const q = new URLSearchParams({ pane_id: String(pane) });
  if (plan.endpoint === "/api/paste-file") q.set("name", plan.name);
  return `${plan.endpoint}?${q.toString()}`;
}
