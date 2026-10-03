import { useCallback, useEffect, useMemo, useState } from "react";
import { Cable, Clock, Copy, Pencil, Plus, RefreshCw, Save, Search, Trash2, Usb, X } from "lucide-react";
import { serialApi, type SerialPortInfo, type SerialProfile, type SshApiClient, type SshRecent } from "@/lib/sshApi";
import { BAUD_RATES, groupBy, matchesProfile, portLabel, recentItems, serialFormError, serialShort } from "@/lib/sshUtil";
import { cn } from "@/lib/utils";
import { SshBtn, SshColorDot, SshConfirm, SshField, sshInput } from "./SshCommon";

const EMPTY: Partial<SerialProfile> = {
  name: "",
  group: "",
  port: "",
  baud: 115200,
  data_bits: 8,
  parity: "none",
  stop_bits: "1",
  flow: "none",
  line_ending: "cr",
  local_echo: false,
  timestamps: false,
  log_file: "",
  color: "",
  notes: "",
};

/** Perfis de porta serial: listar, criar/editar, conectar (terminal no host). */
export function SshSerialPanel({
  conn,
  readOnly,
  onConnect,
  onMessage,
}: {
  conn: SshApiClient;
  readOnly: boolean;
  onConnect: (p: SerialProfile) => void;
  onMessage: (text: string, tone: "ok" | "err") => void;
}) {
  const [profiles, setProfiles] = useState<SerialProfile[]>([]);
  const [recent, setRecent] = useState<SshRecent[]>([]);
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<Partial<SerialProfile> | null>(null);
  const [confirmDel, setConfirmDel] = useState<SerialProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    serialApi
      .list(conn)
      .then((r) => {
        setProfiles(r.profiles);
        setRecent(r.recent);
      })
      .catch((e: Error) => onMessage(e.message, "err"));
  }, [conn, onMessage]);
  const scanPorts = useCallback(() => {
    setPorts(null);
    serialApi
      .ports(conn)
      .then((r) => setPorts(r.ports))
      .catch((e: Error) => {
        setPorts([]);
        onMessage(e.message, "err");
      });
  }, [conn, onMessage]);
  useEffect(() => {
    reload();
    scanPorts();
  }, [reload, scanPorts]);

  const shown = useMemo(() => profiles.filter((p) => matchesProfile(p, query)), [profiles, query]);
  const groups = useMemo(() => groupBy(shown), [shown]);
  const recents = useMemo(() => recentItems(recent, profiles), [recent, profiles]);
  const current = profiles.find((p) => p.id === sel) ?? null;
  const present = new Set((ports ?? []).map((p) => p.port));

  const save = () => {
    if (!edit) return;
    const e = serialFormError(edit);
    if (e) return setErr(e);
    serialApi
      .save(conn, { ...edit, baud: Number(edit.baud), data_bits: Number(edit.data_bits) })
      .then((r) => {
        setEdit(null);
        setErr(null);
        setSel(r.profile.id);
        reload();
      })
      .catch((x: Error) => setErr(x.message));
  };
  const set = <K extends keyof SerialProfile>(k: K, v: SerialProfile[K]) => setEdit((o) => ({ ...o, [k]: v }));

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* lista */}
      <div className="flex w-72 shrink-0 flex-col">
        <div className="mb-2 flex items-center gap-1 rounded border border-border-strong bg-bg-panel px-2">
          <Search size={13} className="text-text-3" />
          <input className="w-full bg-transparent py-1 text-[13px] text-text-1 outline-none" placeholder="Buscar perfil…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <SshBtn tone="primary" className="mb-2 justify-center" disabled={readOnly} onClick={() => setEdit({ ...EMPTY, port: ports?.[0]?.port ?? "" })}>
          <Plus size={14} /> Novo perfil serial
        </SshBtn>
        <div className="min-h-0 flex-1 overflow-auto">
          {recents.length > 0 && !query && (
            <div className="mb-2">
              <div className="mb-1 flex items-center gap-1 text-[11px] uppercase tracking-wide text-text-3">
                <Clock size={11} /> Recentes
              </div>
              {recents.map((p) => (
                <ProfileRow key={`r${p.id}`} p={p} active={sel === p.id} present={present.has(p.port)} onClick={() => setSel(p.id)} onDouble={() => onConnect(p)} />
              ))}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.group} className="mb-2">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-text-3">{g.group}</div>
              {g.items.map((p) => (
                <ProfileRow key={p.id} p={p} active={sel === p.id} present={present.has(p.port)} onClick={() => setSel(p.id)} onDouble={() => onConnect(p)} />
              ))}
            </div>
          ))}
          {profiles.length === 0 && <div className="p-2 text-[12px] text-text-3">Nenhum perfil ainda. Crie um para cada placa/porta que você usa.</div>}
        </div>
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 flex items-center gap-1 text-[11px] uppercase tracking-wide text-text-3">
            <Usb size={11} /> Portas detectadas
            <div className="flex-1" />
            <button title="Procurar de novo" className="rounded p-0.5 hover:bg-bg-hover" onClick={scanPorts}>
              <RefreshCw size={11} className={cn(ports === null && "animate-spin")} />
            </button>
          </div>
          {ports?.length === 0 && <div className="text-[12px] text-text-3">Nenhuma porta serial encontrada.</div>}
          {ports?.map((p) => (
            <button
              key={p.port}
              className="block w-full truncate rounded px-1 py-0.5 text-left text-[12px] text-text-2 hover:bg-bg-hover hover:text-text-1"
              title={[portLabel(p), p.manufacturer, p.serial_number && `nº de série ${p.serial_number}`].filter(Boolean).join("\n")}
              disabled={readOnly}
              onClick={() => setEdit({ ...EMPTY, port: p.port, name: (p.friendly_name ?? p.port).replace(/\s*\(COM\d+\)\s*$/i, "") })}
            >
              {portLabel(p)}
            </button>
          ))}
        </div>
      </div>

      {/* detalhe / editor */}
      <div className="min-w-0 flex-1 rounded border border-border bg-bg-panel/40 p-3">
        {edit ? (
          <div className="flex h-full flex-col">
            <div className="mb-3 flex items-center">
              <div className="text-[15px] font-semibold text-text-1">{edit.id ? `Editar ${edit.name}` : "Novo perfil serial"}</div>
              <div className="flex-1" />
              <SshBtn tone="ghost" onClick={() => setEdit(null)}>
                <X size={14} /> Cancelar
              </SshBtn>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-3 content-start gap-3 overflow-auto">
              <SshField label="Porta">
                <select className={sshInput} value={edit.port ?? ""} onChange={(e) => set("port", e.target.value)}>
                  <option value="">— escolha —</option>
                  {(ports ?? []).map((p) => (
                    <option key={p.port} value={p.port}>
                      {portLabel(p)}
                    </option>
                  ))}
                  {edit.port && !present.has(edit.port) && <option value={edit.port}>{edit.port} (não conectada agora)</option>}
                </select>
              </SshField>
              <SshField label="Ou digite a porta" hint="Para uma porta que ainda não está conectada.">
                <input className={sshInput} value={edit.port ?? ""} onChange={(e) => set("port", e.target.value.toUpperCase())} placeholder="COM3" />
              </SshField>
              <SshField label="Nome na lista">
                <input className={sshInput} value={edit.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder={edit.port || "Minha placa"} />
              </SshField>
              <SshField label="Velocidade (baud)">
                <input className={sshInput} list="serial-bauds" value={edit.baud ?? 115200} onChange={(e) => set("baud", Number(e.target.value))} />
                <datalist id="serial-bauds">
                  {BAUD_RATES.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </SshField>
              <SshField label="Bits de dados">
                <select className={sshInput} value={edit.data_bits ?? 8} onChange={(e) => set("data_bits", Number(e.target.value))}>
                  {[8, 7, 6, 5].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </SshField>
              <SshField label="Paridade">
                <select className={sshInput} value={edit.parity ?? "none"} onChange={(e) => set("parity", e.target.value as SerialProfile["parity"])}>
                  <option value="none">Nenhuma</option>
                  <option value="even">Par</option>
                  <option value="odd">Ímpar</option>
                  <option value="mark">Marca</option>
                  <option value="space">Espaço</option>
                </select>
              </SshField>
              <SshField label="Bits de parada">
                <select className={sshInput} value={edit.stop_bits ?? "1"} onChange={(e) => set("stop_bits", e.target.value as SerialProfile["stop_bits"])}>
                  <option value="1">1</option>
                  <option value="1.5">1,5</option>
                  <option value="2">2</option>
                </select>
              </SshField>
              <SshField label="Controle de fluxo">
                <select className={sshInput} value={edit.flow ?? "none"} onChange={(e) => set("flow", e.target.value as SerialProfile["flow"])}>
                  <option value="none">Nenhum</option>
                  <option value="rtscts">Hardware (RTS/CTS)</option>
                  <option value="xonxoff">Software (XON/XOFF)</option>
                </select>
              </SshField>
              <SshField label="Enter envia">
                <select className={sshInput} value={edit.line_ending ?? "cr"} onChange={(e) => set("line_ending", e.target.value as SerialProfile["line_ending"])}>
                  <option value="cr">CR (\r)</option>
                  <option value="lf">LF (\n)</option>
                  <option value="crlf">CR+LF (\r\n)</option>
                </select>
              </SshField>
              <label className="flex items-center gap-2 text-[12px] text-text-2">
                <input type="checkbox" checked={!!edit.local_echo} onChange={(e) => set("local_echo", e.target.checked)} />
                Eco local (mostrar o que eu digito)
              </label>
              <label className="flex items-center gap-2 text-[12px] text-text-2">
                <input type="checkbox" checked={!!edit.timestamps} onChange={(e) => set("timestamps", e.target.checked)} />
                Hora em cada linha recebida
              </label>
              <SshField label="Grupo">
                <input className={sshInput} value={edit.group ?? ""} onChange={(e) => set("group", e.target.value)} />
              </SshField>
              <div className="col-span-3">
                <SshField label="Salvar o que chegar em arquivo (opcional)" hint="Caminho completo; o texto recebido é acrescentado ao fim do arquivo.">
                  <input className={sshInput} value={edit.log_file ?? ""} onChange={(e) => set("log_file", e.target.value)} placeholder="C:\logs\placa.log" />
                </SshField>
              </div>
              <div className="col-span-3">
                <SshField label="Notas">
                  <textarea className={cn(sshInput, "h-16 resize-y")} value={edit.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
                </SshField>
              </div>
            </div>
            {err && <div className="mt-2 rounded bg-status-err/10 px-2 py-1.5 text-[12px] text-status-err">{err}</div>}
            <div className="mt-3 flex justify-end">
              <SshBtn tone="primary" onClick={save} disabled={readOnly}>
                <Save size={14} /> Salvar
              </SshBtn>
            </div>
          </div>
        ) : current ? (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <SshColorDot color={current.color} />
              <div className="text-[16px] font-semibold text-text-1">{current.name}</div>
            </div>
            <div className="mb-3 font-mono text-[12px] text-text-2">
              {current.port} · {serialShort(current)} · fluxo {current.flow === "none" ? "nenhum" : current.flow === "rtscts" ? "RTS/CTS" : "XON/XOFF"} · Enter ={" "}
              {current.line_ending.toUpperCase()}
            </div>
            {!present.has(current.port) && ports !== null && (
              <div className="mb-3 rounded bg-status-warn/10 px-2 py-1.5 text-[12px] text-text-1">
                {current.port} não está conectada agora. Ao conectar, o terminal espera a porta aparecer.
              </div>
            )}
            <div className="mb-4 flex flex-wrap gap-2">
              <SshBtn tone="primary" disabled={readOnly} onClick={() => onConnect(current)}>
                <Cable size={14} /> Conectar
              </SshBtn>
              <SshBtn disabled={readOnly} onClick={() => setEdit(current)}>
                <Pencil size={14} /> Editar
              </SshBtn>
              <SshBtn
                disabled={readOnly}
                onClick={() =>
                  serialApi
                    .duplicate(conn, current.id)
                    .then((r) => {
                      setSel(r.profile.id);
                      reload();
                    })
                    .catch((e: Error) => onMessage(e.message, "err"))
                }
              >
                <Copy size={14} /> Duplicar
              </SshBtn>
              <SshBtn tone="danger" disabled={readOnly} onClick={() => setConfirmDel(current)}>
                <Trash2 size={14} /> Apagar
              </SshBtn>
            </div>
            <div className="text-[12px] text-text-3">
              O terminal abre no BethTerm (também aparece na janela nativa) e continua aberto se a interface web for fechada. Ctrl+] encerra a
              sessão.
              {current.local_echo && " Eco local ligado."}
              {current.timestamps && " Hora em cada linha."}
              {current.log_file && ` Log: ${current.log_file}.`}
            </div>
            {current.notes && <div className="mt-3 whitespace-pre-wrap rounded bg-bg-panel p-2 text-[12px] text-text-2">{current.notes}</div>}
          </div>
        ) : (
          <div className="p-4 text-[13px] text-text-3">Escolha um perfil à esquerda, ou clique numa porta detectada para criar um.</div>
        )}
      </div>
      {confirmDel && (
        <SshConfirm
          title={`Apagar o perfil ${confirmDel.name}?`}
          confirmLabel="Apagar"
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => {
            const id = confirmDel.id;
            setConfirmDel(null);
            serialApi
              .remove(conn, id)
              .then(() => {
                setSel(null);
                reload();
              })
              .catch((e: Error) => onMessage(e.message, "err"));
          }}
        >
          Só o perfil salvo é apagado; terminais já abertos continuam.
        </SshConfirm>
      )}
    </div>
  );
}

function ProfileRow({ p, active, present, onClick, onDouble }: { p: SerialProfile; active: boolean; present: boolean; onClick: () => void; onDouble: () => void }) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDouble}
      title="Clique para ver; duplo clique para conectar"
      className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left", active ? "bg-accent-soft text-text-1" : "text-text-2 hover:bg-bg-hover")}
    >
      <SshColorDot color={p.color} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-text-1">{p.name}</span>
        <span className="block truncate font-mono text-[11px] text-text-3">
          {p.port} · {serialShort(p)}
        </span>
      </span>
      <span className={cn("h-1.5 w-1.5 rounded-full", present ? "bg-status-ok" : "bg-border-strong")} title={present ? "conectada" : "não conectada"} />
    </button>
  );
}
