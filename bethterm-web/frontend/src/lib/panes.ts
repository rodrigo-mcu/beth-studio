import type { PaneInfo } from "./types";

export interface TabGroup {
  tabId: number;
  label: string;
  panes: PaneInfo[];
}

export interface WindowGroup {
  windowId: number;
  label: string;
  tabs: TabGroup[];
}

/** Agrupa os panes por janela e aba (ordem estavel por id). */
export function groupPanes(panes: PaneInfo[]): WindowGroup[] {
  const wins = new Map<number, Map<number, PaneInfo[]>>();
  for (const p of panes) {
    let tabs = wins.get(p.window_id);
    if (!tabs) {
      tabs = new Map();
      wins.set(p.window_id, tabs);
    }
    let list = tabs.get(p.tab_id);
    if (!list) {
      list = [];
      tabs.set(p.tab_id, list);
    }
    list.push(p);
  }
  const winIds = [...wins.keys()].sort((a, b) => a - b);
  return winIds.map((wid, wi) => {
    const tabs = wins.get(wid)!;
    const tabIds = [...tabs.keys()].sort((a, b) => a - b);
    const first = tabs.get(tabIds[0])![0];
    return {
      windowId: wid,
      label: first.window_title?.trim() || `Janela ${wi + 1}`,
      tabs: tabIds.map((tid, ti) => {
        const ps = tabs.get(tid)!.sort((a, b) => a.pane_id - b.pane_id);
        return {
          tabId: tid,
          label: ps[0].tab_title?.trim() || `Aba ${ti + 1}`,
          panes: ps,
        };
      }),
    };
  });
}

/** file://host/C:/x/y -> C:\x\y ; file://host/home/u/x -> ~/x ; encurta. */
export function shortCwd(cwd: string, maxSegments = 3): string {
  if (!cwd) return "";
  const { path, sep } = cwdPath(cwd);
  const parts = path.split(sep);
  if (parts.length <= maxSegments + 1) return path;
  return `…${sep}` + parts.slice(-maxSegments).join(sep);
}

/**
 * cwd do host ("file://host/caminho") como caminho legivel: decodificado,
 * "/C:/x" vira "C:\x", sem barra no fim, e a pasta do usuario vira "~".
 */
export function cwdPath(cwd: string): { path: string; sep: "/" | "\\" } {
  let path = cwd;
  if (path.startsWith("file://")) {
    const rest = path.slice("file://".length);
    const slash = rest.indexOf("/");
    path = slash >= 0 ? rest.slice(slash) : "/";
    try {
      path = decodeURIComponent(path);
    } catch {
      /* mantem como veio */
    }
  }
  let sep: "/" | "\\" = "/";
  if (/^\/[A-Za-z]:\//.test(path)) {
    path = path.slice(1).replace(/\//g, "\\");
    sep = "\\";
  }
  if (path.length > 3) path = path.replace(/[\\/]+$/, "");
  const home = [/^C:\\Users\\[^\\]+/i, /^\/home\/[^/]+/, /^\/root(?=\/|$)/];
  for (const re of home) {
    if (re.test(path)) {
      path = path.replace(re, "~");
      break;
    }
  }
  return { path, sep };
}

/**
 * Titulo que e' so' o caminho do executavel do shell
 * (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`).
 * O PowerShell 5.1 grava isso no titulo do console; nao e' a pasta do terminal.
 */
export function isShellExeTitle(title: string): boolean {
  const t = title.trim();
  return /(?:^|[\\/])(powershell|pwsh|cmd|wsl|bash|conhost|openconsole)(\.exe)?$/i.test(t);
}

export function paneLabel(p: PaneInfo): string {
  // SSH: preferir user@host:port (kind_label / ssh_host) — o titulo do
  // processo Windows às vezes vira "bethterm-tool.exe" / ".old".
  if (p.kind === "ssh") {
    const host = p.ssh_host?.trim();
    if (host) return host;
    const kl = p.kind_label?.replace(/^SSH\s*·\s*/i, "").trim();
    if (kl) return kl;
  }
  const t = p.title?.trim();
  const shellExe = !!t && isShellExeTitle(t);
  if (t && !shellExe && !/bethterm-tool(\.exe)?(\.old)?/i.test(t)) return t;
  if (shellExe) {
    const kl = p.kind_label?.trim();
    if (kl && p.kind && p.kind !== "unknown" && p.kind !== "other") return kl;
    const base = t!.split(/[\\/]/).pop();
    if (base) return base;
  }
  if (p.kind === "ssh" && p.kind_label) return p.kind_label.replace(/^SSH\s*·\s*/i, "").trim() || t || `Terminal ${p.pane_id}`;
  return t || `Terminal ${p.pane_id}`;
}
