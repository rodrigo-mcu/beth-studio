import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { ALargeSmall, ArrowDown, ChevronLeft } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { AgentInfo } from "@/lib/agents";
import type { PaneInfo } from "@/lib/types";
import { nextScrollOffset, plainScreen } from "@/lib/phoneScreen";
import { Composer } from "./Composer";
import { ThemePicker } from "./theme";
import { screenLines, waitedFor } from "./text";

interface ViewPrefs {
  size: number;
  wrap: boolean;
}

const PREFS_KEY = "bethphone.view";

function loadPrefs(): ViewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<ViewPrefs> | null;
    if (v && typeof v.size === "number") return { size: Math.min(20, Math.max(10, v.size)), wrap: v.wrap !== false };
  } catch {
    /* sem storage */
  }
  return { size: 13, wrap: true };
}

function savePrefs(p: ViewPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* sem storage */
  }
}

interface Props {
  conn: Connection;
  info: PaneInfo;
  agent: AgentInfo | undefined;
  /** nome da aba dado no Studio, ou o título do terminal */
  name: string;
  readOnly: boolean;
  banner: ReactNode;
  onBack: () => void;
}

export function AgentChat({ conn, info, agent, name, readOnly, banner, onBack }: Props) {
  const [screen, setScreen] = useState("");
  const [offset, setOffset] = useState(0);
  const [scrollback, setScrollback] = useState(0);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [menu, setMenu] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const scrollbackRef = useRef(0);
  offsetRef.current = offset;
  scrollbackRef.current = scrollback;

  const setView = (p: ViewPrefs) => {
    setPrefs(p);
    savePrefs(p);
  };

  useEffect(() => {
    return conn.onScreen(info.pane_id, (ev) => {
      setScreen(plainScreen(ev.text));
      setOffset(ev.offset ?? 0);
      setScrollback(ev.scrollback ?? 0);
    });
  }, [conn, info.pane_id]);

  // Ao vivo: fica colado no fim, onde o agente escreve — também quando o
  // teclado abre e a área encolhe. Se a pessoa subiu para ler, não puxa.
  const atBottom = useRef(true);
  useEffect(() => {
    if (offset === 0 && atBottom.current && screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight;
  }, [screen, offset, prefs]);
  useEffect(() => {
    atBottom.current = true;
  }, [info.pane_id, offset]);
  useEffect(() => {
    const el = screenRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (offsetRef.current === 0 && atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [info.pane_id]);

  const bump = (deltaLines: number) => {
    const next = nextScrollOffset(offsetRef.current, deltaLines, scrollbackRef.current);
    if (next !== offsetRef.current) conn.scroll(info.pane_id, next);
  };

  // Arrastar além do topo pede o histórico ao PC (a tela só traz o que cabe no terminal).
  const touchY = useRef<number | null>(null);
  const touchAcc = useRef(0);
  const tap = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  const focusField = useRef<(() => void) | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const t0 = e.touches[0];
    touchY.current = t0?.clientY ?? null;
    touchAcc.current = 0;
    tap.current = t0 ? { x: t0.clientX, y: t0.clientY, t: Date.now(), moved: false } : null;
  };
  // Toque curto no texto (sem arrastar, sem segurar para selecionar): abre o teclado no campo.
  const onTouchEnd = () => {
    const t = tap.current;
    tap.current = null;
    if (!t || t.moved || Date.now() - t.t > 350) return;
    if (window.getSelection()?.toString()) return;
    focusField.current?.();
  };
  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY;
    const x = e.touches[0]?.clientX;
    if (tap.current && x != null && y != null && Math.hypot(x - tap.current.x, y - tap.current.y) > 8) tap.current.moved = true;
    if (y == null || touchY.current == null) return;
    const el = screenRef.current;
    const atTop = !el || el.scrollTop <= 0;
    const atBottom = !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const dy = touchY.current - y;
    touchY.current = y;
    if (dy > 0 && !atBottom) return;
    if (dy < 0 && !atTop) return;
    touchAcc.current += dy;
    const lines = Math.trunc(touchAcc.current / 24);
    if (!lines) return;
    touchAcc.current -= lines * 24;
    bump(-lines * 2);
  };

  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const step = Math.trunc(e.deltaY / 40) || (e.deltaY > 0 ? 1 : -1);
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom && offsetRef.current > 0)) {
        e.preventDefault();
        bump(-step);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [info.pane_id]);

  const lines = useMemo(() => screenLines(screen), [screen]);
  const status = offset > 0 ? `Histórico, ${offset} linhas acima` : agent ? `Esperando você ${waitedFor(agent.since, Date.now())}` : "Ao vivo";

  return (
    <>
      <header className="p-top p-top--chat">
        <button type="button" className="p-icon-btn" aria-label="Voltar para a lista" onClick={onBack}>
          <ChevronLeft size={26} />
        </button>
        <div className="p-top__main">
          <div className="p-title">{name}</div>
          <div className={agent && offset === 0 ? "p-sub p-sub--wait" : "p-sub"}>
            {agent && offset === 0 && <span className="p-dot p-dot--wait" />}
            {status}
          </div>
        </div>
        <button type="button" className="p-icon-btn" aria-label="Texto e tema" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <ALargeSmall size={22} />
        </button>
      </header>
      {menu && (
        <>
          <div className="p-scrim" onClick={() => setMenu(false)} />
          <div className="p-menu" role="dialog" aria-label="Leitura">
            <label>
              Tamanho do texto
              <span className="p-stepper">
                <button type="button" aria-label="Diminuir" disabled={prefs.size <= 10} onClick={() => setView({ ...prefs, size: prefs.size - 1 })}>
                  A−
                </button>
                <button type="button" aria-label="Aumentar" disabled={prefs.size >= 20} onClick={() => setView({ ...prefs, size: prefs.size + 1 })}>
                  A+
                </button>
              </span>
            </label>
            <label>
              Quebrar linhas longas
              <input type="checkbox" checked={prefs.wrap} onChange={(e) => setView({ ...prefs, wrap: e.target.checked })} />
            </label>
            <div className="p-menu__hint">Sem quebrar, as caixas e tabelas do agente ficam no lugar; arraste para o lado para ler.</div>
            <ThemePicker />
          </div>
        </>
      )}
      {banner}
      <div className="p-term-wrap">
        <div
          ref={screenRef}
          className={prefs.wrap ? "p-term p-term--wrap" : "p-term p-term--nowrap"}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
          }}
        >
          {screen ? (
            <pre style={{ fontSize: `${prefs.size}px` }}>
              {lines.map((l, i) => (l.rule ? <span key={i} className="p-rule" /> : <span key={i} className="p-ln">{l.text || " "}</span>))}
            </pre>
          ) : (
            <p className="p-term__wait">Carregando a tela deste terminal…</p>
          )}
        </div>
        {offset > 0 && (
          <button type="button" className="p-live" onClick={() => conn.scroll(info.pane_id, 0)}>
            <ArrowDown size={16} />
            Ao vivo
          </button>
        )}
      </div>
      <Composer conn={conn} paneId={info.pane_id} readOnly={readOnly} focusRef={focusField} fontSize={prefs.size} />
    </>
  );
}
