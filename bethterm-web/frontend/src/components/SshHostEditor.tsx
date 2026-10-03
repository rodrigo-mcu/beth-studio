import { useState } from "react";
import { KeyRound, Plug, Save, X } from "lucide-react";
import { sshApi, type SshApiClient, type SshAuth, type SshHost } from "@/lib/sshApi";
import { hostFormError } from "@/lib/sshUtil";
import { cn } from "@/lib/utils";
import { SshBtn, SshField, SshKeyFlow, sshInput, type SshKeyIssue } from "./SshCommon";

const COLORS = ["", "#2F81F7", "#3FB950", "#D29922", "#F85149", "#A371F7", "#DB61A2", "#8B949E"];

const AUTH_LABEL: Record<SshAuth, string> = {
  password: "Senha",
  key: "Arquivo de chave",
  agent: "Agente SSH do Windows",
};

/** Criar/editar um host salvo (+ testar a conexão antes de salvar). */
export function SshHostEditor({
  conn,
  initial,
  groups,
  readOnly,
  onSaved,
  onCancel,
}: {
  conn: SshApiClient;
  initial: SshHost | null;
  groups: string[];
  readOnly: boolean;
  onSaved: (h: SshHost) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Partial<SshHost>>(
    initial ?? { name: "", group: "", host: "", port: 22, user: "", auth: "password", key_path: "", color: "", tag: "", notes: "", initial_dir: "" },
  );
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(true);
  const [clearPassword, setClearPassword] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [savePassphrase, setSavePassphrase] = useState(true);
  const [clearPassphrase, setClearPassphrase] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [keyIssue, setKeyIssue] = useState<SshKeyIssue | null>(null);

  const set = <K extends keyof SshHost>(k: K, v: SshHost[K]) => setF((o) => ({ ...o, [k]: v }));
  const typed = { password: f.auth === "password" ? password : undefined, passphrase: f.auth === "key" ? passphrase : undefined };

  const save = () => {
    const err = hostFormError(f);
    if (err) return setMsg({ text: err, tone: "err" });
    setBusy("save");
    setMsg(null);
    sshApi
      .save(conn, { ...f, port: Number(f.port) || 22 }, {
        password,
        save_password: savePassword && !!password,
        clear_password: clearPassword,
        passphrase,
        save_passphrase: savePassphrase && !!passphrase,
        clear_passphrase: clearPassphrase,
      })
      .then((r) => onSaved(r.host))
      .catch((e: Error) => setMsg({ text: e.message, tone: "err" }))
      .finally(() => setBusy(""));
  };

  const test = () => {
    const err = hostFormError(f);
    if (err) return setMsg({ text: err, tone: "err" });
    setBusy("test");
    setMsg(null);
    const host = { ...f, port: Number(f.port) || 22 };
    const target = { host };
    sshApi
      .test(conn, target, typed)
      .then((r) => {
        if (r.ok) setMsg({ text: "Conexão OK: servidor alcançado e login aceito.", tone: "ok" });
        else if (r.host_key && (r.code === "unknown_host_key" || r.code === "host_key_mismatch"))
          setKeyIssue({ info: r.host_key, target: { ...target, id: initial?.id }, typed });
        else setMsg({ text: r.error ?? "Falhou.", tone: "err" });
      })
      .catch((e: Error) => setMsg({ text: e.message, tone: "err" }))
      .finally(() => setBusy(""));
  };

  const hasSavedPw = !!initial?.has_password && !clearPassword;
  const hasSavedPp = !!initial?.has_passphrase && !clearPassphrase;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <div className="text-[15px] font-semibold text-text-1">{initial ? `Editar ${initial.name}` : "Novo host SSH"}</div>
        <div className="flex-1" />
        <SshBtn tone="ghost" onClick={onCancel} title="Fechar sem salvar">
          <X size={14} /> Cancelar
        </SshBtn>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-auto pr-1">
        <SshField label="Endereço (host ou IP)">
          <input className={sshInput} value={f.host ?? ""} onChange={(e) => set("host", e.target.value)} placeholder="servidor.exemplo.com" autoFocus />
        </SshField>
        <div className="grid grid-cols-[1fr_90px] gap-3">
          <SshField label="Usuário">
            <input className={sshInput} value={f.user ?? ""} onChange={(e) => set("user", e.target.value)} placeholder="usuario" />
          </SshField>
          <SshField label="Porta">
            <input className={sshInput} type="number" min={1} max={65535} value={f.port ?? 22} onChange={(e) => set("port", Number(e.target.value))} />
          </SshField>
        </div>
        <SshField label="Nome na lista" hint="Vazio = o endereço.">
          <input className={sshInput} value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder={f.host || "Meu servidor"} />
        </SshField>
        <SshField label="Grupo">
          <input className={sshInput} list="ssh-groups" value={f.group ?? ""} onChange={(e) => set("group", e.target.value)} placeholder="ex.: Clientes, Casa" />
          <datalist id="ssh-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </SshField>

        <div className="col-span-2">
          <div className="mb-1 text-[12px] text-text-2">Autenticação</div>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(AUTH_LABEL) as SshAuth[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => set("auth", a)}
                className={cn(
                  "rounded border px-3 py-1 text-[12px]",
                  f.auth === a ? "border-accent bg-accent/20 text-text-1" : "border-border-strong text-text-2 hover:bg-bg-hover",
                )}
              >
                {AUTH_LABEL[a]}
              </button>
            ))}
          </div>
        </div>

        {f.auth === "password" && (
          <div className="col-span-2 grid grid-cols-2 gap-3 rounded border border-border p-2">
            {hasSavedPw ? (
              <div className="col-span-2 flex items-center gap-2 text-[12px] text-text-2">
                <KeyRound size={14} className="text-status-ok" /> Senha salva (cifrada neste computador).
                <SshBtn tone="ghost" onClick={() => setClearPassword(true)}>
                  Apagar senha salva
                </SshBtn>
                <span className="text-text-3">ou digite outra abaixo para trocar.</span>
              </div>
            ) : (
              <div className="col-span-2 text-[12px] text-text-3">
                Sem senha salva: o terminal pergunta ao conectar{clearPassword ? " (a senha salva será apagada ao salvar)" : ""}.
              </div>
            )}
            <SshField label="Senha">
              <input className={sshInput} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </SshField>
            <label className="mt-5 flex items-center gap-2 text-[12px] text-text-2">
              <input type="checkbox" checked={savePassword} onChange={(e) => setSavePassword(e.target.checked)} />
              Salvar a senha (cifrada com a conta do Windows)
            </label>
          </div>
        )}
        {f.auth === "key" && (
          <div className="col-span-2 grid grid-cols-2 gap-3 rounded border border-border p-2">
            <SshField label="Arquivo da chave privada" hint="ex.: ~/.ssh/id_ed25519 (formato OpenSSH ou PEM; converta .ppk no PuTTYgen)">
              <input className={sshInput} value={f.key_path ?? ""} onChange={(e) => set("key_path", e.target.value)} placeholder="~/.ssh/id_ed25519" />
            </SshField>
            <SshField label={hasSavedPp ? "Frase-senha (salva — digite para trocar)" : "Frase-senha (se a chave tiver)"}>
              <input className={sshInput} type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </SshField>
            <div className="col-span-2 flex items-center gap-3 text-[12px] text-text-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={savePassphrase} onChange={(e) => setSavePassphrase(e.target.checked)} />
                Salvar a frase-senha (cifrada)
              </label>
              {hasSavedPp && (
                <SshBtn tone="ghost" onClick={() => setClearPassphrase(true)}>
                  Apagar frase-senha salva
                </SshBtn>
              )}
            </div>
          </div>
        )}
        {f.auth === "agent" && (
          <div className="col-span-2 rounded border border-border p-2 text-[12px] text-text-2">
            Usa as chaves carregadas no serviço “OpenSSH Authentication Agent” do Windows (adicione com <code>ssh-add</code>). Nenhuma credencial
            é salva aqui.
          </div>
        )}

        <SshField label="Etiqueta" hint="Texto curto na lista (ex.: prod, lab).">
          <input className={sshInput} value={f.tag ?? ""} onChange={(e) => set("tag", e.target.value)} />
        </SshField>
        <SshField label="Cor">
          <div className="flex gap-1.5 pt-1">
            {COLORS.map((c) => (
              <button
                key={c || "none"}
                type="button"
                title={c || "Sem cor"}
                onClick={() => set("color", c)}
                className={cn("h-5 w-5 rounded-full border", (f.color ?? "") === c ? "border-text-1 ring-2 ring-accent" : "border-border-strong")}
                style={{ background: c || "transparent" }}
              />
            ))}
          </div>
        </SshField>
        <SshField label="Pasta inicial dos arquivos (SFTP)" hint="Vazio = a pasta do usuário.">
          <input className={sshInput} value={f.initial_dir ?? ""} onChange={(e) => set("initial_dir", e.target.value)} placeholder="/var/www" />
        </SshField>
        <div />
        <div className="col-span-2">
          <SshField label="Notas">
            <textarea className={cn(sshInput, "h-20 resize-y")} value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
          </SshField>
        </div>
      </div>

      {msg && (
        <div className={cn("mt-2 rounded px-2 py-1.5 text-[12px]", msg.tone === "ok" ? "bg-status-ok/10 text-status-ok" : "bg-status-err/10 text-status-err")}>
          {msg.text}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <SshBtn onClick={test} disabled={!!busy}>
          <Plug size={14} /> {busy === "test" ? "Testando…" : "Testar conexão"}
        </SshBtn>
        <SshBtn tone="primary" onClick={save} disabled={!!busy || readOnly} title={readOnly ? "Modo somente leitura" : undefined}>
          <Save size={14} /> {busy === "save" ? "Salvando…" : "Salvar"}
        </SshBtn>
      </div>
      {keyIssue && <SshKeyFlow conn={conn} issue={keyIssue} onDone={() => setKeyIssue(null)} onMessage={(text, tone) => setMsg({ text, tone })} />}
    </div>
  );
}
