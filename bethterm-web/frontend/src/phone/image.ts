import { fitSize, needsReencode } from "./imageFit";

async function decode(file: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
  if ("createImageBitmap" in window) {
    try {
      const b = await createImageBitmap(file);
      return { src: b, w: b.width, h: b.height, close: () => b.close() };
    } catch {
      /* HEIC no Safari: cai no <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Imagem pronta para subir: a original quando serve, senão JPEG reduzido. */
export async function prepareImage(file: File): Promise<Blob> {
  let d;
  try {
    d = await decode(file);
  } catch {
    throw new Error("Não consegui abrir essa imagem. Tente um print ou uma foto em JPEG/PNG.");
  }
  try {
    if (!needsReencode(file.type, file.size, d.w, d.h)) return file;
    const { w, h } = fitSize(d.w, d.h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Este navegador não conseguiu preparar a imagem.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(d.src, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.88));
    if (!blob) throw new Error("Este navegador não conseguiu preparar a imagem.");
    return blob;
  } finally {
    d.close();
  }
}
