import { useCallback, useEffect, useState } from "react";
import { checkSession, type SessionState } from "./session";
import { LoginScreen } from "./LoginScreen";
import { Studio } from "./Studio";
import { Mark } from "./Mark";

export function PhoneApp() {
  const [state, setState] = useState<SessionState>("checking");

  const recheck = useCallback(() => {
    void checkSession().then(setState);
  }, []);

  useEffect(recheck, [recheck]);

  if (state === "checking") {
    return (
      <div className="p-gate" aria-busy="true">
        <Mark className="p-gate__mark" />
      </div>
    );
  }
  if (state === "login") return <LoginScreen onIn={() => setState("in")} />;
  if (state === "offline") {
    return (
      <div className="p-gate">
        <Mark className="p-gate__mark" />
        <h1>O computador está desconectado</h1>
        <p>O Beth Studio no PC não está ligado ao servidor agora. Confira se o PC está ligado e com internet.</p>
        <button type="button" className="p-send" onClick={() => { setState("checking"); recheck(); }}>
          Tentar de novo
        </button>
      </div>
    );
  }
  return <Studio local={state === "local"} onSession={setState} />;
}
