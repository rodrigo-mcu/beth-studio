import { useState } from "react";
import { Mark } from "./Mark";
import { login } from "./session";

export function LoginScreen({ onIn }: { onIn: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="p-gate"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !pw) return;
        setBusy(true);
        setErr("");
        void login(pw).then((problem) => {
          setBusy(false);
          if (problem) {
            setErr(problem);
            return;
          }
          onIn();
        });
      }}
    >
      <Mark className="p-gate__mark" />
      <h1>Beth Studio</h1>
      <p>Entre com a senha do celular que você criou no PC, em Configurações → Celular.</p>
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Senha do celular"
        aria-label="Senha do celular"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        autoFocus
      />
      <div className="p-gate__err" role="alert">
        {err}
      </div>
      <button type="submit" className="p-send" disabled={busy || !pw}>
        {busy ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
