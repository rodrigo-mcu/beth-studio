import { useEffect, useState, type ReactNode } from "react";
import { LayoutGrid, List, LogOut, MoreVertical, RefreshCw, Search, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { AgentState } from "@/lib/agents";
import type { PaneInfo } from "@/lib/types";
import { shortCwd } from "@/lib/panes";
import { orderPhonePanes } from "@/lib/phoneScreen";
import { Mark } from "./Mark";
import { logout } from "./session";
import { ThemePicker } from "./theme";
import { PaneGrid } from "./PaneGrid";
import { byRecent, filterPanes, kindChips, kindText, KIND_LABELS, waitedFor, type KindFilter, type Recent } from "./text";

// Busca e filtro sobrevivem a abrir um terminal e voltar.
let keptQuery = "";
let keptKind: KindFilter = "all";

const VIEW_KEY = "bethphone.view";
type View = "list" | "grid";
function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

interface Props {
  conn: Connection;
  panes: PaneInfo[] | null;
  agents: AgentState;
  /** quando cada terminal foi aberto neste celular */
  recent: Recent;
  /** nome da aba dado no Studio, ou o título do terminal */
  nameOf: (p: PaneInfo) => string;
  online: boolean;
  gone: boolean;
  banner: ReactNode;
  canLogout: boolean;
  /** ordem dos tipos escolhida em Configurações no Studio */
  kindOrder?: string[] | null;
  onOpen: (id: number) => void;
  onLogout: () => void;
}

export function AgentList({ conn, panes, agents, recent, nameOf, online, gone, banner, canLogout, kindOrder, onOpen, onLogout }: Props) {
  const [menu, setMenu] = useState(false);
  const [view, setViewState] = useState<View>(loadView);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* sem storage */
    }
  };
  const [now, setNow] = useState(() => Date.now());
  const [query, setQueryState] = useState(keptQuery);
  const [kind, setKindState] = useState<KindFilter>(keptKind);
  const setQuery = (q: string) => {
    keptQuery = q;
    setQueryState(q);
  };
  const setKind = (k: KindFilter) => {
    keptKind = k;
    setKindState(k);
  };

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const label = nameOf;
  const all = panes ? orderPhonePanes(panes, agents, label) : null;
  const chips = all ? kindChips(all) : [];
  const activeKind = chips.includes(kind) ? kind : "all";
  const list = all ? filterPanes(all, query, activeKind, label) : null;
  const filtering = query.trim() !== "" || activeKind !== "all";
  const waiting = list?.filter((p) => agents[p.pane_id]) ?? [];
  const rest = byRecent(list?.filter((p) => !agents[p.pane_id]) ?? [], recent);

  const row = (p: PaneInfo) => {
    const a = agents[p.pane_id];
    const cwd = shortCwd(p.cwd, 4);
    const kind = kindText(p.kind_label, p.agent);
    return (
      <button key={p.pane_id} type="button" className={a ? "p-item p-item--wait" : "p-item"} onClick={() => onOpen(p.pane_id)}>
        <span className="p-item__body">
          <span className="p-item__name" style={{ display: "block" }}>
            {label(p)}
          </span>
          <span className="p-item__meta" style={{ display: "block" }}>
            {cwd ? `${kind} · ${cwd}` : kind}
          </span>
        </span>
        {a && <span className="p-item__when">{waitedFor(a.since, now)}</span>}
      </button>
    );
  };

  return (
    <>
      <header className="p-top">
        <Mark className="p-mark" />
        <div className="p-top__main">
          <div className="p-title">Beth Studio</div>
          <div className="p-sub">
            <span className={online ? "p-dot p-dot--ok" : "p-dot"} />
            {online ? "Conectado ao PC" : "Sem conexão com o PC"}
          </div>
        </div>
        <button
          type="button"
          className="p-icon-btn"
          aria-label={view === "grid" ? "Ver como lista" : "Ver todos os terminais em grade"}
          aria-pressed={view === "grid"}
          onClick={() => setView(view === "grid" ? "list" : "grid")}
        >
          {view === "grid" ? <List size={20} /> : <LayoutGrid size={20} />}
        </button>
        <button type="button" className="p-icon-btn" aria-label="Atualizar a lista" onClick={() => conn.refreshList()}>
          <RefreshCw size={20} />
        </button>
        <button type="button" className="p-icon-btn" aria-label="Mais opções" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <MoreVertical size={20} />
        </button>
      </header>
      {menu && (
        <>
          <div className="p-scrim" onClick={() => setMenu(false)} />
          <div className="p-menu" role="dialog" aria-label="Opções">
            <ThemePicker />
            {canLogout && (
              <button
                type="button"
                onClick={() => {
                  setMenu(false);
                  void logout().then(onLogout);
                }}
              >
                Sair deste celular
                <LogOut size={18} />
              </button>
            )}
          </div>
        </>
      )}
      {banner}
      {all && all.length > 0 && view === "list" && (
        <div className="p-find">
          <label className="p-search">
            <Search size={18} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Procurar terminal"
              aria-label="Procurar terminal"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button type="button" aria-label="Limpar a busca" onClick={() => setQuery("")}>
                <X size={18} />
              </button>
            )}
          </label>
          {chips.length > 2 && (
            <div className="p-chips" role="group" aria-label="Tipo de terminal">
              {chips.map((k) => (
                <button key={k} type="button" className="p-chip" aria-pressed={activeKind === k} onClick={() => setKind(k)}>
                  {k === "all" ? "Todos" : KIND_LABELS[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="p-scroll">
        {gone && <p className="p-note">Esse terminal foi encerrado no PC.</p>}
        {!list && (
          <div className="p-empty">
            <strong>Buscando os terminais</strong>
            Se demorar, o Beth Studio no PC pode estar fechado.
          </div>
        )}
        {view === "list" && list && list.length === 0 && filtering && (
          <div className="p-empty">
            <strong>Nenhum terminal com esse filtro</strong>
            <button type="button" className="p-link" onClick={() => { setQuery(""); setKind("all"); }}>
              Mostrar todos
            </button>
          </div>
        )}
        {view === "list" && list && list.length === 0 && !filtering && (
          <div className="p-empty">
            <strong>Nenhum terminal aberto</strong>
            Abra um terminal no Beth Studio do PC e ele aparece aqui.
          </div>
        )}
        {view === "grid" && all && <PaneGrid conn={conn} panes={all} kindOrder={kindOrder} agents={agents} nameOf={label} now={now} onOpen={onOpen} />}
        {view === "list" && waiting.length > 0 && (
          <>
            <div className="p-group p-group--wait">{waiting.length === 1 ? "Esperando você" : `${waiting.length} esperando você`}</div>
            {waiting.map(row)}
          </>
        )}
        {view === "list" && rest.length > 0 && (
          <>
            {waiting.length > 0 && <div className="p-group">Outros terminais</div>}
            {rest.map(row)}
          </>
        )}
      </div>
    </>
  );
}
