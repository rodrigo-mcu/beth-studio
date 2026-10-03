// Eventos da ponte (`bethterm cli bridge`, patch 0171) repassados pelo Go.

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
  /** tipo do terminal (panekind.go): wsl | powershell | pwsh | cmd | gitbash | mobaxterm | other | unknown */
  kind?: string;
  kind_label?: string;
  distro?: string;
  /** so' SSH: host remoto (user@host:port ou host solto) */
  ssh_host?: string;
  /** so' SSH salvo: id hex do ssh-hosts.json (abre janela SFTP) */
  ssh_host_id?: string;
  /** titulo de agente (Claude Code etc.) */
  agent?: boolean;
  kind_source?: "gui" | "web" | "heuristic";
  /** roda dentro do WSL (kind wsl, ou agente/outro com cwd Linux) — panekind.go */
  wsl?: boolean;
  /** distro do WSL deste pane (argv, cwd UNC ou a distro padrão do registro) */
  wsl_distro?: string;
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
  text: string;
  /** Linhas acima da tela viva sendo mostradas (0 = ao vivo). */
  offset?: number;
  /** Quantas linhas de historico existem acima da tela viva. */
  scrollback?: number;
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

export interface Appearance {
  theme?: string;
  font_family?: string;
  /** 0 ou ausente = ajustar a' area */
  font_size?: number;
  /** so' por pane: fit = ajustar o pane do host a' janela; host = espelhar */
  size_mode?: "fit" | "host" | "";
  /** negrito (ausente = herda o padrao do web, depois o da GUI) */
  font_bold?: boolean;
}

export interface PaneAppearance extends Appearance {
  title?: string;
  cwd?: string;
}

export interface SettingsEvent {
  ev: "settings";
  /** pane id -> nome de aba dado pelo usuario (guardado por pane) */
  pane_names?: Record<string, string>;
  default: Appearance;
  gui_default_theme?: string;
  gui_default_font?: string;
  gui_default_bold?: boolean;
  panes: Record<string, PaneAppearance>;
  font_favorites: string[];
  theme_favorites: string[];
  gui_favorites_error?: string;
  /** organizacao do web (abas/splits), ver lib/layout.ts */
  layout?: unknown;
  ui_theme?: { mode: "dark" | "light" | "navy" | "follow" | "theme"; theme_id?: string };
  sidebar?: { collapsed: boolean; width: number; view?: "web" | "host" | "kind" | "folder"; kinds?: string[]; kind_order?: string[]; split_by_kind?: boolean };
}

export interface XtermColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeInfo {
  id: string;
  name: string;
  source: "builtin" | "gogh" | "vscode";
  detail?: string;
  dark: boolean;
  gui: boolean;
  colors: XtermColors;
  /** chaves do workbench (so' temas do VS Code) */
  ui?: Record<string, string>;
}

export interface FontInfo {
  family: string;
  mono: boolean;
}

export interface FontPreset {
  label: string;
  family: string;
  size?: number;
}

export interface ShellInfo {
  id: string;
  label: string;
}

export interface ShellsEvent {
  ev: "shells";
  shells: ShellInfo[];
}

export interface SpawnedEvent {
  ev: "spawned";
  request_id?: string;
  pane_id: number;
  tab_id: number;
  window_id: number;
}

export type ServerEvent =
  | ListEvent
  | ScreenEvent
  | ErrorEvent
  | StatusEvent
  | SettingsEvent
  | ShellsEvent
  | SpawnedEvent
  | { ev: "pane_gone"; pane_id: number }
  | { ev: "separated"; pane_id: number; tab_id: number; window_id: number }
  | { ev: "term_windows"; panes: number[] }
  | import("./hostBanner").HostEvent
  | { ev: "ui_open"; what: "tasks" }
  | { ev: "term_drag"; pane: number; x: number; y: number; end: boolean; attach?: boolean }
  | import("./agents").AgentEvent;

export type SocketState = "connecting" | "open" | "closed";
