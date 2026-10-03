// Protocolo WS do bethstudio-web (o Go repassa a ponte `bethstudio cli bridge`,
// patch 0171). Mesmos formatos de bethstudio-web/frontend/src/lib/types.ts.

export interface PaneSize {
  rows: number;
  cols: number;
  pixel_width?: number;
  pixel_height?: number;
  dpi?: number;
}

export interface PaneInfo {
  window_id: number;
  tab_id: number;
  pane_id: number;
  workspace: string;
  size: PaneSize;
  title: string;
  cwd: string;
  cursor_x: number;
  cursor_y: number;
  tab_title: string;
  window_title: string;
  is_active: boolean;
  is_zoomed: boolean;
}

export interface ListEvent {
  ev: "list";
  panes: PaneInfo[];
}

export interface ScreenEvent {
  ev: "screen";
  pane_id: number;
  cols: number;
  rows: number;
  cursor_x: number;
  cursor_y: number;
  cursor_visible: boolean;
  /** Linhas com escapes SGR, separadas por CRLF, sem CRLF no fim. */
  text: string;
  /** Linhas acima da tela viva sendo mostradas (0 = ao vivo). */
  offset: number;
  /** Linhas de historico acima da tela viva. */
  scrollback: number;
}

export interface ErrorEvent {
  ev: "error";
  message: string;
}

export type BridgeState = "starting" | "up" | "down";

export interface StatusEvent {
  ev: "status";
  state: BridgeState;
  message: string;
  read_only: boolean;
  exe?: string;
}

/** Eventos que o app entende. `settings` do bethstudio-web e' ignorado. */
export type ServerEvent = ListEvent | ScreenEvent | ErrorEvent | StatusEvent;

export type ClientRequest =
  | { op: "list" }
  | { op: "watch"; pane_ids: number[] }
  | { op: "scroll"; pane_id: number; offset: number }
  | { op: "send"; pane_id: number; data: string }
  | { op: "paste"; pane_id: number; data: string };

export type SocketState = "idle" | "connecting" | "open" | "closed";
