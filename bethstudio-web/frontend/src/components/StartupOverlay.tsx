import { useEffect, useRef, useState } from "react";
import type { Connection } from "@/lib/connection";
import { onScreened, screenedPanes, startupItems, startupLogLine, startupStage, type StageKey } from "@/lib/startup";
import type { SocketState } from "@/lib/types";

// quando o módulo do App terminou de carregar (ms desde o início da página)
const appLoadedAt = typeof performance !== "undefined" ? performance.now() : 0;

interface Props {
  conn: Connection;
  socket: SocketState;
  paneCount: number | null;
  layoutReady: boolean;
  activePanes: number[];
  /** todos os terminais do host (nome para a lista da abertura) */
  allPanes: { id: number; label: string }[];
}

/**
 * Tela de abertura: cobre o Studio até a lista de terminais chegar e os
 * terminais da aba ativa receberem a primeira tela, dizendo a etapa. Mesmo
 * visual do #boot do index.html (continua de onde ele parou). Some de vez
 * depois da primeira abertura (reconexões mostram o LED da barra de abas).
 * Grava no log do Go a linha "abertura (página): …" com o tempo de cada fase.
 */
export function StartupOverlay({ conn, socket, paneCount, layoutReady, activePanes, allPanes }: Props) {
  const [, setTick] = useState(0);
  const [finished, setFinished] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const stageRef = useRef<{ key: string; since: number }>({ key: "", since: performance.now() });
  const times = useRef<Partial<Record<StageKey | "app", number>>>({ app: appLoadedAt });

  // redesenha quando chega uma tela e a cada segundo (aviso de demora)
  useEffect(() => onScreened(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    if (finished) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [finished]);

  const now = performance.now();
  const stage = startupStage({
    socket,
    paneCount,
    layoutReady,
    activePanes,
    screened: screenedPanes(),
    stageMs: now - stageRef.current.since,
  });
  const done = finished || skipped || stage.done;

  // etapa nova: guarda quando a anterior terminou
  if (stage.key !== stageRef.current.key) {
    const order: StageKey[] = ["connect", "list", "layout", "screens"];
    const idx = stage.key === "done" ? order.length : order.indexOf(stage.key as StageKey);
    for (const k of order.slice(0, idx)) if (times.current[k] === undefined) times.current[k] = now;
    stageRef.current = { key: stage.key, since: now };
  }

  useEffect(() => {
    if (!done || finished) return;
    setFinished(true);
    const shown = activePanes.filter((p) => screenedPanes().has(p)).length;
    const line = startupLogLine(times.current, paneCount ?? 0, shown, activePanes.length) + (skipped ? " · pulado pelo usuário" : "");
    void conn.api("/api/log", { msg: line }).catch(() => undefined);
  }, [done, finished, skipped, activePanes, paneCount, conn]);

  if (done) return null;
  const list = startupItems(stage.key, allPanes, activePanes, screenedPanes());
  return (
    <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3.5 bg-bg-body text-[15px] text-text-2">
      {/* mesmo giro do #boot: animação de CSS (compositor), gira mesmo com a página ocupada */}
      <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-text-3/25 border-t-accent" />
      <div>{stage.text}</div>
      {list.items.length > 0 && (
        <ul className="flex max-w-[420px] flex-col gap-0.5 text-[12.5px] text-text-3">
          {list.items.map((it) => (
            <li key={it.id} className="flex items-center gap-2">
              {it.state === "ok" ? (
                <span className="w-3 text-center text-status-ok">✓</span>
              ) : (
                <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-text-3/30 border-t-accent" />
              )}
              <span className={it.state === "ok" ? "truncate text-text-3" : "truncate text-text-2"}>{it.label}</span>
            </li>
          ))}
          {list.more > 0 && <li className="pl-5">… e mais {list.more}</li>}
        </ul>
      )}
      {stage.slow && (
        <div className="flex flex-col items-center gap-2 text-[13px] text-text-3">
          <span>{stage.action === "retry" ? "O Beth Studio está demorando para responder." : "Algum terminal ainda não mandou a tela."}</span>
          {stage.action === "retry" ? (
            <button className="rounded bg-accent px-3 py-1 text-white hover:bg-accent-hover" onClick={() => conn.reconnectNow()}>
              Tentar de novo
            </button>
          ) : (
            <button className="rounded bg-accent px-3 py-1 text-white hover:bg-accent-hover" onClick={() => setSkipped(true)}>
              Mostrar assim mesmo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
