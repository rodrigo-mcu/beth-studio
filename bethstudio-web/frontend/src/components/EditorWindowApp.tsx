import { useState } from "react";
import type { Connection } from "@/lib/connection";
import { isFrameless, startDrag, useWindowState, winCommand } from "@/lib/windowFrame";
import { cn } from "@/lib/utils";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { FileKindIcon } from "./FileKindIcon";
import { TopResizeEdges, WindowControls } from "./WindowControls";

/**
 * Processo --editor: o editor de um arquivo numa janela própria do Windows
 * (Configurações > Aparência > Editor de arquivos > Janela separada).
 * Não abre o WebSocket do Studio: só as rotas HTTP de arquivo e notas.
 */
const q = new URLSearchParams(window.location.search);
const token = q.get("t") ?? "";

async function call(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("X-BethStudio-Token", token);
  return fetch(path, { ...init, headers, credentials: "include" });
}

// Só o que o painel usa: api (com status, para o 409 de conflito) e getBlob.
const conn = {
  async api<T>(path: string, body?: unknown): Promise<T> {
    const r = await call(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${r.status}`), { status: r.status });
    return data as T;
  },
  async getBlob(path: string, signal?: AbortSignal): Promise<{ blob: Blob; headers: Headers }> {
    const r = await call(path, { signal });
    if (!r.ok) {
      const data = await r.json().catch(() => null as { error?: string } | null);
      throw new Error(data?.error || `HTTP ${r.status}`);
    }
    return { blob: await r.blob(), headers: r.headers };
  },
} as unknown as Connection;

export function EditorWindowApp() {
  const [path, setPath] = useState(q.get("path") ?? "");
  const win = useWindowState();
  const name = path.replace(/^.*[\\/]/, "");
  if (!path) {
    return <div className="flex h-full items-center justify-center text-text-2">Falta ?path= na URL</div>;
  }
  return (
    <div className="flex h-full flex-col bg-bg text-[13px] text-text-1">
      <TopResizeEdges state={win} />
      {isFrameless() && (
        <header
          className={cn("flex h-8 shrink-0 items-stretch border-b border-border bg-bg-raised select-none", !win.active && "opacity-75")}
        >
          <div
            className="flex min-w-0 flex-1 items-center gap-2 px-3"
            onMouseDown={startDrag}
            onDoubleClick={() => winCommand("toggle")}
            title="Arraste para mover a janela; duplo clique maximiza"
          >
            <FileKindIcon name={name} size={14} />
            <span className="truncate font-semibold">{name}</span>
            <span className="truncate text-[11px] text-text-3">{path.replace(/[\\/][^\\/]*$/, "")}</span>
          </div>
          <WindowControls state={win} />
        </header>
      )}
      <div className="min-h-0 flex-1">
        <FilePreviewPanel
          conn={conn}
          path={path}
          editOnOpen={q.get("edit") === "1" ? q.get("path") : null}
          docked
          onClose={() => winCommand("close")}
          onOpen={setPath}
        />
      </div>
    </div>
  );
}
