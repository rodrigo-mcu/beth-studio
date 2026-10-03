import type { ClientRequest, ListEvent, PaneInfo, ScreenEvent, ServerEvent, StatusEvent } from "./types";

// Validacao defensiva: o app pode falar com um servidor remoto, entao nada
// do que chega e' confiado sem checar tipo.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const int = (v: unknown, d = 0): number => (isInt(v) ? v : d);

/** Limites que a ponte/servidor tambem aplicam. */
export const MAX_OFFSET = 1_000_000;
export const MAX_DATA_BYTES = 4 << 20;
export const MAX_WATCH = 16;

function parsePane(v: unknown): PaneInfo | null {
  if (!isObj(v) || !isInt(v.pane_id) || v.pane_id < 0) return null;
  const size = isObj(v.size) ? v.size : {};
  return {
    window_id: int(v.window_id),
    tab_id: int(v.tab_id),
    pane_id: v.pane_id,
    workspace: str(v.workspace),
    size: {
      rows: int(size.rows, 24),
      cols: int(size.cols, 80),
      pixel_width: isInt(size.pixel_width) ? size.pixel_width : undefined,
      pixel_height: isInt(size.pixel_height) ? size.pixel_height : undefined,
      dpi: isInt(size.dpi) ? size.dpi : undefined,
    },
    title: str(v.title),
    cwd: str(v.cwd),
    cursor_x: int(v.cursor_x),
    cursor_y: int(v.cursor_y),
    tab_title: str(v.tab_title),
    window_title: str(v.window_title),
    is_active: v.is_active === true,
    is_zoomed: v.is_zoomed === true,
  };
}

function parseList(o: Record<string, unknown>): ListEvent | null {
  if (!Array.isArray(o.panes)) return null;
  const panes: PaneInfo[] = [];
  for (const p of o.panes) {
    const pane = parsePane(p);
    if (pane) panes.push(pane);
  }
  return { ev: "list", panes };
}

function parseScreen(o: Record<string, unknown>): ScreenEvent | null {
  if (!isInt(o.pane_id) || !isInt(o.cols) || !isInt(o.rows) || typeof o.text !== "string") return null;
  if (o.cols <= 0 || o.rows <= 0 || o.cols > 2000 || o.rows > 1000) return null;
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
  return {
    ev: "screen",
    pane_id: o.pane_id,
    cols: o.cols,
    rows: o.rows,
    cursor_x: clamp(int(o.cursor_x), o.cols - 1),
    cursor_y: clamp(int(o.cursor_y), o.rows - 1),
    cursor_visible: o.cursor_visible === true,
    text: o.text,
    offset: clamp(int(o.offset), MAX_OFFSET),
    scrollback: Math.max(0, int(o.scrollback)),
  };
}

function parseStatus(o: Record<string, unknown>): StatusEvent | null {
  const state = o.state;
  if (state !== "starting" && state !== "up" && state !== "down") return null;
  return { ev: "status", state, message: str(o.message), read_only: o.read_only === true, exe: typeof o.exe === "string" ? o.exe : undefined };
}

/** Uma mensagem de texto do WS -> evento, ou null se invalida/desconhecida. */
export function parseServerEvent(raw: string): ServerEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.ev) {
    case "list":
      return parseList(v);
    case "screen":
      return parseScreen(v);
    case "status":
      return parseStatus(v);
    case "error":
      return { ev: "error", message: str(v.message, "erro desconhecido") };
    default:
      return null;
  }
}

/** Monta a requisicao validada (o que vai no fio), ou lanca erro. */
export function buildRequest(req: ClientRequest): string {
  switch (req.op) {
    case "list":
      return JSON.stringify({ op: "list" });
    case "watch": {
      const ids = [...new Set(req.pane_ids.filter((id) => isInt(id) && id >= 0))].sort((a, b) => a - b).slice(0, MAX_WATCH);
      return JSON.stringify({ op: "watch", pane_ids: ids });
    }
    case "scroll": {
      if (!isInt(req.pane_id) || req.pane_id < 0) throw new Error("scroll: pane_id inválido");
      const offset = Math.max(0, Math.min(MAX_OFFSET, Math.round(req.offset)));
      return JSON.stringify({ op: "scroll", pane_id: req.pane_id, offset });
    }
    case "send":
    case "paste": {
      if (!isInt(req.pane_id) || req.pane_id < 0) throw new Error(`${req.op}: pane_id inválido`);
      if (!req.data) throw new Error(`${req.op}: texto vazio`);
      if (utf8Length(req.data) > MAX_DATA_BYTES) throw new Error("texto grande demais");
      return JSON.stringify({ op: req.op, pane_id: req.pane_id, data: req.data });
    }
  }
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
