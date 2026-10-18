import { useCallback, useEffect, useState } from "react";
import { checkSessionDetail, type SessionState } from "./session";
import { LoginScreen } from "./LoginScreen";
import { Studio } from "./Studio";
import { Mark } from "./Mark";
import { clearPairFragment, exchangePair, hasPairFragment, parsePairFragment, type PairResult } from "./pair";
import { formatLastSeen, OFFLINE_RETRY_MS } from "./offline";

type Screen = SessionState | "pairing" | "pairfail";

// O link mágico só pode ser trocado uma vez: o efeito do React pode rodar
// duas vezes (StrictMode), então a troca é guardada aqui.
let pairing: Promise<PairResult> | null = null;

function startPairing(): Promise<PairResult> {
  if (pairing) return pairing;
  const token = parsePairFragment(location.hash);
  clearPairFragment(location, history); // o token sai da barra e do histórico já
  pairing = token ? exchangePair(token) : Promise.resolve({ ok: false, error: "Link inválido ou expirado." });
  return pairing;
}

export function PhoneApp() {
  const [state, setState] = useState<Screen>(() => (hasPairFragment(location.hash) ? "pairing" : "checking"));
  const [lastSeen, setLastSeen] = useState<Date | null>(null);
  const [pairError, setPairError] = useState("");

  const recheck = useCallback(() => {
    void checkSessionDetail().then((d) => {
      setLastSeen(d.lastSeen);
      setState(d.state);
    });
  }, []);

  useEffect(() => {
    if (state !== "pairing") {
      recheck();
      return;
    }
    let off = false;
    void startPairing().then((res) => {
      if (off) return;
      if (res.ok) {
        pairing = null;
        recheck();
      } else {
        setPairError(res.error);
        setState("pairfail");
      }
    });
    return () => {
      off = true;
    };
    // só na primeira montagem
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Offline: tenta de novo sozinho e atualiza a hora, sem piscar a tela.
  useEffect(() => {
    if (state !== "offline") return;
    const t = window.setInterval(recheck, OFFLINE_RETRY_MS);
    return () => window.clearInterval(t);
  }, [state, recheck]);

  if (state === "checking" || state === "pairing") {
    return (
      <div className="p-gate" aria-busy="true">
        <Mark className="p-gate__mark" />
        {state === "pairing" && <p>Conectando este celular…</p>}
      </div>
    );
  }
  if (state === "pairfail") {
    return (
      <div className="p-gate">
        <Mark className="p-gate__mark" />
        <h1>Não deu para entrar</h1>
        <p>{pairError} Gere um QR code novo no PC, em Configurações → Celular, ou entre com a senha.</p>
        <button type="button" className="p-send" onClick={() => { pairing = null; setState("login"); }}>
          Entrar com a senha
        </button>
      </div>
    );
  }
  if (state === "login") return <LoginScreen onIn={() => setState("in")} />;
  if (state === "offline") {
    const seen = formatLastSeen(lastSeen);
    return (
      <div className="p-gate">
        <Mark className="p-gate__mark" />
        <h1>O computador está desconectado</h1>
        <p>O Beth Studio no PC não está ligado ao servidor agora. Confira se o PC está ligado e com internet.</p>
        {seen && <p data-testid="last-seen">{seen}</p>}
        <p>Tentando de novo sozinho a cada poucos segundos.</p>
        <button type="button" className="p-send" onClick={() => { setState("checking"); recheck(); }}>
          Tentar de novo
        </button>
      </div>
    );
  }
  return <Studio local={state === "local"} onSession={setState} />;
}
