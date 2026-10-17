import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PaneInfo } from "@/lib/types";
import { paneLabel } from "@/lib/panes";
import { Connection } from "@/lib/connection";
import { checkSession, type SessionState } from "./session";
import { offlineVerdict } from "./retry";
import { AgentList } from "./AgentList";
import { AgentChat } from "./AgentChat";
import { cleanTitle, touchRecent, type Recent } from "./text";

const RECENT_KEY = "bethphone.recent";

function loadRecent(): Recent {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Recent;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Já entrou: abre o socket e alterna entre a lista e um terminal. */
export function Studio({ local, onSession }: { local: boolean; onSession: (s: SessionState) => void }) {
  const connRef = useRef<Connection | null>(null);
  if (!connRef.current) connRef.current = new Connection();
  const conn = connRef.current;
  const snap = useSyncExternalStore(conn.subscribe, conn.getSnapshot);
  const [paneId, setPaneId] = useState<number | null>(null);
  const [pcDown, setPcDown] = useState(false);
  const [recent, setRecent] = useState<Recent>(loadRecent);
  const [storedNames, setStoredNames] = useState<Record<string, string>>({});

  // Nomes das abas dados no Studio. Chegam ao vivo quando mudam (evento
  // settings); ao abrir e quando a lista muda, o celular pede de novo.
  const paneKey = snap.panes?.map((p) => p.pane_id).join(",") ?? "";
  useEffect(() => {
    if (snap.socket !== "open") return;
    void conn
      .api<Record<string, string>>("/api/phone/names")
      .then(setStoredNames)
      .catch(() => undefined);
  }, [conn, snap.socket, paneKey]);
  const names = snap.settings?.pane_names ?? storedNames;
  const nameOf = useCallback((p: PaneInfo) => names[String(p.pane_id)]?.trim() || cleanTitle(paneLabel(p)), [names]);

  // Sair do Studio (senha vencida, Sair): fecha o socket antes de trocar de tela.
  const leave = (s: SessionState) => {
    conn.dispose();
    onSession(s);
  };

  useEffect(() => {
    conn.setWatched(paneId != null ? [paneId] : []);
  }, [conn, paneId]);

  // Voltar do Android/gesto do iPhone fecha o terminal em vez de sair do app.
  useEffect(() => {
    const onPop = () => setPaneId(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const open = (id: number) => {
    // O último aberto vai para o topo da lista (fica neste celular).
    const alive = snap.panes ? new Set(snap.panes.map((p) => p.pane_id)) : undefined;
    const next = touchRecent(recent, id, Date.now(), alive);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* sem storage */
    }
    window.history.pushState({ pane: id }, "");
    setPaneId(id);
  };
  const back = () => {
    if (window.history.state?.pane != null) window.history.back();
    else setPaneId(null);
  };

  // Socket caiu: a senha venceu (volta ao login) ou o PC saiu do ar (aviso). Uma
  // checagem que falha uma vez não prova nada (sinal fraco, proxy trocando de
  // sessão): confere de 3 em 3 s e só avisa depois de várias falhas seguidas.
  useEffect(() => {
    if (snap.socket === "open") {
      setPcDown(false);
      return;
    }
    if (local) return;
    let off = false;
    let fails = 0;
    let t = 0;
    const tick = () => {
      void checkSession().then((s) => {
        if (off) return;
        if (s === "login") return leave("login");
        fails = s === "offline" ? fails + 1 : 0;
        setPcDown(offlineVerdict(fails));
        t = window.setTimeout(tick, 3000);
      });
    };
    t = window.setTimeout(tick, 2500);
    return () => {
      off = true;
      window.clearTimeout(t);
    };
  }, [snap.socket, local, onSession]);

  // Voltou ao app depois de um tempo: atualiza a lista.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") conn.refreshList();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [conn]);

  const info = paneId != null ? snap.panes?.find((p) => p.pane_id === paneId) : undefined;
  const banner =
    snap.socket === "open" ? null : pcDown ? (
      <div className="p-banner p-banner--bad" role="status">
        O PC está desconectado do servidor. Tentando de novo…
      </div>
    ) : (
      <div className="p-banner" role="status">
        Conectando ao PC…
      </div>
    );

  return (
    <div className="p-app">
      <div className="p-col">
        {paneId != null && info ? (
          <AgentChat
            conn={conn}
            info={info}
            agent={snap.agents[info.pane_id]}
            name={nameOf(info)}
            readOnly={snap.status?.read_only ?? false}
            banner={banner}
            onBack={back}
          />
        ) : (
          <AgentList
            conn={conn}
            panes={snap.panes}
            agents={snap.agents}
            recent={recent}
            nameOf={nameOf}
            online={snap.socket === "open"}
            gone={paneId != null && snap.panes != null && !info}
            banner={banner}
            canLogout={!local}
            kindOrder={snap.settings?.sidebar?.kind_order}
            onOpen={open}
            onLogout={() => leave("login")}
          />
        )}
      </div>
    </div>
  );
}
