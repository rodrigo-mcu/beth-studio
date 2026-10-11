import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Lock, Plug, Trash2, X } from "lucide-react";
import { dbApi, type DbApiClient, type DbCatalog, type DbConnConfig, type DbConnView, type DbDriver } from "@/lib/dbApi";
import { CONN_COLORS, formatMs, sslLabel } from "@/lib/dbFormat";
import { cn } from "@/lib/utils";

type Form = Omit<DbConnConfig, "id"> & { id?: string };

const inputCls =
  "w-full rounded border border-border bg-bg-panel px-2 py-1.5 text-[12px] text-text-1 outline-none focus:border-accent disabled:opacity-50";

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1 text-[11px] text-text-2", className)}>
      <span>
        {label}
        {hint && <span className="ml-1 text-text-3">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** Criar/editar uma conexão salva. A senha só vai para o Go (cofre DPAPI). */
export function DbConnectionDialog({
  conn,
  catalog,
  editing,
  onSaved,
  onDeleted,
  onClose,
}: {
  conn: DbApiClient;
  catalog: DbCatalog;
  editing: DbConnView | null;
  onSaved: (c: DbConnView) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>(() =>
    editing
      ? { ...editing }
      : { name: "", group: "", driver: "postgres", host: "localhost", port: 5432, database: "", user: "", ssl_mode: "prefer", read_only: false, color: "" },
  );
  const [password, setPassword] = useState("");
  const [clearPw, setClearPw] = useState(false);
  const [busy, setBusy] = useState<"" | "test" | "save" | "delete">("");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dbList, setDbList] = useState<string[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const info = catalog.drivers.find((d) => d.id === form.driver);
  const fileBased = !!info?.file_based;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setTest(null);
  };

  const chooseDriver = (d: DbDriver) => {
    const di = catalog.drivers.find((x) => x.id === d);
    setForm((f) => ({
      ...f,
      driver: d,
      port: di?.default_port && (!f.port || catalog.drivers.some((x) => x.default_port === f.port)) ? di.default_port : f.port,
      ssl_mode: di?.ssl_modes?.includes(f.ssl_mode ?? "") ? f.ssl_mode : di?.default_ssl,
    }));
    setTest(null);
  };

  const payload = (): Partial<DbConnConfig> => {
    const p: Partial<DbConnConfig> = { ...form, id: editing?.id ?? "" };
    delete (p as Partial<DbConnView>).has_password;
    delete (p as Partial<DbConnView>).password_mask;
    return p;
  };

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    setError(null);
    try {
      const r = await dbApi.test(conn, { id: editing?.id, connection: payload(), ...(password ? { password } : {}) });
      if (r.ok) setTest({ ok: true, text: r.message || `Conectou em ${formatMs(r.elapsed_ms ?? 0)}${r.version ? ` · ${r.version}` : ""}` });
      else setTest({ ok: false, text: r.error || "falhou" });
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  };

  // "Selecionar": pergunta ao servidor quais bancos esses dados enxergam.
  const pickDatabase = async () => {
    if (dbList) {
      setDbList(null);
      return;
    }
    setListing(true);
    setListError(null);
    try {
      const r = await dbApi.test(conn, { id: editing?.id, connection: payload(), ...(password ? { password } : {}), list_databases: true });
      if (r.ok) setDbList(r.databases ?? []);
      else setListError(r.error || "não foi possível listar os bancos");
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListing(false);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const r = await dbApi.save(conn, payload(), password || null, clearPw && !password);
      onSaved(r.connection);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const del = async () => {
    if (!editing) return;
    setBusy("delete");
    try {
      await dbApi.remove(conn, editing.id);
      onDeleted(editing.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy("");
    }
  };

  return (
    <div className="fixed inset-0 z-[75] flex items-start justify-center bg-black/50 pt-[5vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Editar conexão" : "Nova conexão"}
        className="flex max-h-[90vh] w-[min(640px,94vw)] flex-col rounded-lg border border-border bg-bg-card text-[12px] text-text-1 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Plug size={16} className="text-accent-text" />
          <span className="text-[15px] font-semibold">{editing ? "Editar conexão" : "Nova conexão"}</span>
          <button className="ml-auto rounded p-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4" style={{ userSelect: "text" }}>
          <div>
            <div className="mb-1 text-[11px] text-text-2">Tipo de banco</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
              {catalog.drivers.map((d) => (
                <button
                  key={d.id}
                  role="radio"
                  aria-checked={form.driver === d.id}
                  className={cn(
                    "rounded border px-2 py-2 text-[12px]",
                    form.driver === d.id ? "border-accent bg-accent-soft text-accent-text" : "border-border bg-bg-panel text-text-2 hover:bg-bg-hover",
                  )}
                  onClick={() => chooseDriver(d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Nome">
              <input ref={nameRef} className={inputCls} value={form.name} placeholder="ex.: Loja (produção)" onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Grupo" hint="(opcional)">
              <input className={inputCls} list="db-groups" value={form.group ?? ""} placeholder="ex.: Clientes, Testes" onChange={(e) => set("group", e.target.value)} />
              <datalist id="db-groups">
                {catalog.groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>
          </div>

          <div>
            <div className="mb-1 text-[11px] text-text-2">Cor da etiqueta</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                className={cn("h-6 rounded border px-2 text-[11px]", !form.color ? "border-accent text-accent-text" : "border-border text-text-3")}
                onClick={() => set("color", "")}
              >
                nenhuma
              </button>
              {CONN_COLORS.map((c) => (
                <button
                  key={c}
                  title={c}
                  className={cn("h-6 w-6 rounded-full border-2", form.color === c ? "border-text-1" : "border-transparent")}
                  style={{ background: c }}
                  onClick={() => set("color", c)}
                />
              ))}
            </div>
          </div>

          {fileBased ? (
            <>
              <Field label="Arquivo do banco" hint="(caminho completo)">
                <input
                  className={cn(inputCls, "font-mono")}
                  value={form.file ?? ""}
                  placeholder="C:\dados\banco.db"
                  onChange={(e) => set("file", e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-text-2">
                <input type="checkbox" checked={!!form.create_file} onChange={(e) => set("create_file", e.target.checked)} />
                Criar o arquivo se ele não existir
              </label>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_110px] gap-3">
                <Field label="Servidor" hint={form.driver === "sqlserver" ? "(host, IP ou host\\instância)" : "(host ou IP)"}>
                  <input className={cn(inputCls, "font-mono")} value={form.host ?? ""} onChange={(e) => set("host", e.target.value)} />
                </Field>
                <Field label="Porta">
                  <input
                    className={cn(inputCls, "font-mono")}
                    inputMode="numeric"
                    value={form.port ? String(form.port) : ""}
                    placeholder={String(info?.default_port ?? "")}
                    onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 0)}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Usuário">
                  <input className={inputCls} value={form.user ?? ""} autoComplete="off" onChange={(e) => set("user", e.target.value)} />
                </Field>
                <Field label="Banco inicial" hint="(se preenchido, abre só este banco)">
                  <div className="flex gap-1.5">
                    <input
                      className={inputCls}
                      value={form.database ?? ""}
                      onChange={(e) => {
                        set("database", e.target.value);
                        setDbList(null);
                      }}
                    />
                    {info?.has_database_level && (
                      <button
                        type="button"
                        className="flex shrink-0 items-center gap-1 rounded border border-border bg-bg-hover px-2 text-[12px] text-text-1 hover:bg-border disabled:opacity-50"
                        title="Conecta com os dados acima e lista os bancos para escolher"
                        aria-expanded={!!dbList}
                        disabled={listing || !!busy}
                        onClick={() => void pickDatabase()}
                      >
                        {listing ? <LoaderCircle size={13} className="animate-spin" /> : <ChevronDown size={13} />}
                        Selecionar
                      </button>
                    )}
                  </div>
                  {listError && <span className="text-[11px] text-status-err">{listError}</span>}
                  {dbList && (
                    <div className="max-h-[180px] overflow-auto rounded border border-border bg-bg-panel" role="listbox" aria-label="Bancos disponíveis">
                      {dbList.length === 0 && <div className="px-2 py-1.5 text-text-3">Nenhum banco acessível</div>}
                      {dbList.map((name) => (
                        <button
                          key={name}
                          type="button"
                          role="option"
                          aria-selected={name === form.database}
                          className={cn("block w-full truncate px-2 py-1 text-left text-[12px] text-text-1 hover:bg-bg-hover", name === form.database && "bg-accent-soft")}
                          onClick={() => {
                            set("database", name);
                            setDbList(null);
                          }}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  )}
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Senha" hint={editing?.has_password ? "(salva — deixe em branco para manter)" : undefined}>
                  <input
                    className={inputCls}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    placeholder={editing?.has_password ? editing.password_mask : ""}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setTest(null);
                    }}
                  />
                  {editing?.has_password && !password && (
                    <span className="flex items-center gap-1.5 text-text-3">
                      <input type="checkbox" checked={clearPw} onChange={(e) => setClearPw(e.target.checked)} /> apagar a senha salva
                    </span>
                  )}
                </Field>
                <Field label="Criptografia (SSL/TLS)">
                  <select className={inputCls} value={form.ssl_mode ?? ""} onChange={(e) => set("ssl_mode", e.target.value)}>
                    {(info?.ssl_modes ?? []).map((m) => (
                      <option key={m} value={m}>
                        {sslLabel(m)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {(catalog.tunnel_ready || form.tunnel) && (
                <Field label="Túnel SSH" hint="(id do host SSH; vazio = conexão direta)">
                  <input className={inputCls} value={form.tunnel ?? ""} onChange={(e) => set("tunnel", e.target.value)} />
                </Field>
              )}
            </>
          )}

          <label className="flex items-start gap-2 rounded border border-border bg-bg-panel p-2 text-text-1">
            <input type="checkbox" className="mt-0.5" checked={form.read_only} onChange={(e) => set("read_only", e.target.checked)} />
            <span>
              <span className="flex items-center gap-1 font-semibold">
                <Lock size={12} /> Somente leitura
              </span>
              <span className="text-text-2">
                Recusa INSERT/UPDATE/DELETE/DDL e roda tudo numa transação de leitura que é sempre desfeita
                {form.driver === "sqlite" ? " (o arquivo também é aberto só para leitura)" : ""}. Recomendado para produção.
              </span>
            </span>
          </label>

          {test && (
            <div className={cn("flex items-start gap-2 rounded border p-2", test.ok ? "border-status-ok/50 text-status-ok" : "border-status-err/50 text-status-err")}>
              {test.ok ? <Check size={14} className="mt-0.5 shrink-0" /> : <X size={14} className="mt-0.5 shrink-0" />}
              <span className="break-words">{test.text}</span>
            </div>
          )}
          {error && <div className="rounded border border-status-err/50 p-2 text-status-err">{error}</div>}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          {editing &&
            (confirmDelete ? (
              <span className="flex items-center gap-2 text-status-err">
                Excluir “{editing.name}”?
                <button className="rounded bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]" disabled={!!busy} onClick={del}>
                  Excluir
                </button>
                <button className="rounded bg-bg-hover px-3 py-1 text-text-1" onClick={() => setConfirmDelete(false)}>
                  Não
                </button>
              </span>
            ) : (
              <button className="flex items-center gap-1 rounded px-2 py-1.5 text-text-2 hover:bg-bg-hover hover:text-status-err" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} /> Excluir
              </button>
            ))}
          <button
            className="ml-auto flex items-center gap-1.5 rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border disabled:opacity-50"
            disabled={!!busy}
            onClick={runTest}
          >
            {busy === "test" ? <LoaderCircle size={14} className="animate-spin" /> : <Plug size={14} />} Testar conexão
          </button>
          <button className="rounded bg-bg-hover px-3 py-1.5 text-text-1 hover:bg-border" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="flex items-center gap-1.5 rounded bg-accent px-4 py-1.5 font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            disabled={!!busy || !form.name.trim()}
            onClick={save}
          >
            {busy === "save" && <LoaderCircle size={14} className="animate-spin" />} Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
