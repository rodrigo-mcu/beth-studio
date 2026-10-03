import type { PaneInfo } from "./types";

// Mesmo agrupamento da barra lateral do bethstudio-web: Janela -> Aba -> terminal.

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
    const first = tabs.get(tabIds[0]!)![0]!;
    return {
      windowId: wid,
      label: first.window_title?.trim() || `Janela ${wi + 1}`,
      tabs: tabIds.map((tid, ti) => {
        const ps = [...tabs.get(tid)!].sort((a, b) => a.pane_id - b.pane_id);
        return { tabId: tid, label: ps[0]!.tab_title?.trim() || `Aba ${ti + 1}`, panes: ps };
      }),
    };
  });
}

/** file://host/C:/x/y -> C:\x\y ; file://host/home/u/x -> ~/x ; encurta. */
export function shortCwd(cwd: string, maxSegments = 3): string {
  if (!cwd) return "";
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
  let sep = "/";
  if (/^\/[A-Za-z]:\//.test(path)) {
    path = path.slice(1).replace(/\//g, "\\");
    sep = "\\";
  }
  if (path.length > 3) path = path.replace(/[\\/]+$/, "");
  for (const re of [/^C:\\Users\\[^\\]+/i, /^\/home\/[^/]+/, /^\/root(?=\/|$)/]) {
    if (re.test(path)) {
      path = path.replace(re, "~");
      break;
    }
  }
  const parts = path.split(sep);
  if (parts.length <= maxSegments + 1) return path;
  return `\u2026${sep}` + parts.slice(-maxSegments).join(sep);
}

export function paneLabel(p: PaneInfo): string {
  return p.title?.trim() || `Terminal ${p.pane_id}`;
}
