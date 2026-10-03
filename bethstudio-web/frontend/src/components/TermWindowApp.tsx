import { useEffect, useMemo, useSyncExternalStore } from "react";
import { PanelTopOpen } from "lucide-react";
import { Connection } from "@/lib/connection";
import { loadCatalog, useCatalog } from "@/lib/appearance";
import { paneLabel } from "@/lib/panes";
import { useWindowState, winCommand } from "@/lib/windowFrame";
import { LIGHT, NAVY_DARK, VSCODE_DARK, applyUI, deriveUI, normalizeUIMode, type UIColors } from "@/lib/uiTheme";
import { IconButton } from "./IconButton";
import { TerminalView } from "./TerminalView";
import { TopResizeEdges, WindowControls } from "./WindowControls";

const conn = new Connection();
// Temas e fontes: sem isto o terminal cai no tema padrao (visual diferente do da aba).
void loadCatalog(conn);
const pane = Number(new URLSearchParams(window.location.search).get("pane"));

/**
 * Processo --term: um terminal destacado em janela nativa. Usa o mesmo
 * servidor e o mesmo host do Studio. Fechar a janela NUNCA encerra o terminal.
 */
export function TermWindowApp() {
  const snap = useSyncExternalStore(conn.subscribe, conn.getSnapshot);
  const winState = useWindowState();
  const catalog = useCatalog();
  const info = useMemo(() => snap.panes?.find((p) => p.pane_id === pane), [snap.panes]);

  // mesmo tema da interface do Studio
  const defaultThemeId = snap.settings?.default?.theme ?? "";
  const colors = useMemo<UIColors>(() => {
    const m = snap.settings?.ui_theme;
    const mode = normalizeUIMode(m?.mode);
    if (mode === "dark") return VSCODE_DARK;
    if (mode === "navy") return NAVY_DARK;
    if (mode === "light") return LIGHT;
    if (mode === "follow" && !defaultThemeId) return VSCODE_DARK;
    const t = catalog.themeById.get(mode === "follow" ? defaultThemeId : (m?.theme_id ?? ""));
    return t ? deriveUI(t) : VSCODE_DARK;
  }, [snap.settings, catalog, defaultThemeId]);
  useEffect(() => applyUI(colors), [colors]);

  useEffect(() => {
    conn.setWatched([pane]);
  }, []);

  const title = info ? paneLabel(info) : `Terminal ${pane}`;
  useEffect(() => {
    document.title = `Terminal ${pane}`; // o Go acha a janela por este titulo
  }, []);

  const attach = () => {
    // pede ao Studio para encaixar na aba ativa; ele fecha esta janela
    void conn.api("/api/term/drag", { pane_id: pane, x: 0, y: 0, end: true, attach: true }).catch(() => undefined);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-bg-body text-text-1">
      <TopResizeEdges state={winState} />
      <div
        className="flex h-7 shrink-0 select-none items-start gap-2 border-b border-border px-2 pt-1"
        onMouseDown={(e) => {
          if (e.button === 0 && !(e.target as HTMLElement).closest("button,[data-no-drag]")) winCommand("drag");
        }}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest("button,[data-no-drag]")) winCommand("toggle");
        }}
      >
        <span className="min-w-0 flex-1 truncate pl-1 text-xs leading-6 text-text-2">{title}</span>
        <div className="flex h-6 items-center">
          <IconButton label="Encaixar de volta no Beth Studio" onClick={attach}>
            <PanelTopOpen size={15} />
          </IconButton>
        </div>
        <WindowControls state={winState} closeTitle="Fechar a janela (o terminal continua rodando)" />
      </div>
      <div className="flex min-h-0 flex-1 p-1">
        <TerminalView
          conn={conn}
          paneId={pane}
          pane={info}
          listLoaded={snap.panes !== null}
          readOnly={snap.status?.read_only ?? false}
          settings={snap.settings}
          focused={false}
          canClose={false}
          onFocus={() => undefined}
          onClose={() => winCommand("close")}
          aloneInHost
        />
      </div>
    </div>
  );
}
