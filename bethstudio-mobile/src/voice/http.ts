// Rede de verdade (fetch do RN e envio de arquivo do expo-file-system) atrás
// da interface HttpClient de api.ts. Fina de propósito: a lógica está em api.ts.

import { File, UploadType } from "expo-file-system";
import type { HttpClient, HttpResult } from "./api";

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

function lower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k] ?? "";
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TypeError("Tempo esgotado ao falar com o servidor.")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new TypeError(String(e)));
      },
    );
  });
}

export const nativeHttp: HttpClient = {
  async request(req): Promise<HttpResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      // credentials "omit": o cookie vai explícito no cabeçalho, para o app não
      // depender do que o iOS/Android guardam por conta própria.
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: "omit", signal: ac.signal });
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: r.status, body: await r.text(), headers };
    } finally {
      clearTimeout(timer);
    }
  },

  async uploadFile(req): Promise<HttpResult> {
    const file = new File(req.fileUri);
    const r = await withTimeout(
      file.upload(req.url, {
        httpMethod: "POST",
        uploadType: UploadType.BINARY_CONTENT,
        headers: req.headers,
        mimeType: req.headers["Content-Type"],
      }),
      UPLOAD_TIMEOUT_MS,
    );
    return { status: r.status, body: r.body, headers: lower(r.headers) };
  },
};
