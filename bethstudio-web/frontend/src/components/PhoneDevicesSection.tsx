import { useCallback, useEffect, useState } from "react";
import type { Connection } from "@/lib/connection";
import {
  agoLabel,
  countdownLabel,
  deviceTitle,
  pairingState,
  type DevicesView,
  type Pairing,
  type PhoneDevice,
} from "@/lib/phoneDevices";

/**
 * Configurações → Celular → Aparelhos conectados: QR code de uso único e a lista
 * de aparelhos (renomear, revogar, revogar todos). O Studio remoto não vê isto.
 */
export function PhoneDevicesSection({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [view, setView] = useState<DevicesView | null>(null);
  const [missing, setMissing] = useState(false); // Studio antigo, sem esta API
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(() => {
    void conn
      .api<DevicesView>("/api/phone/devices")
      .then((v) => {
        // Studio antigo: a rota não existe (404, ou a página no lugar do JSON)
        if (!Array.isArray(v?.devices)) {
          setMissing(true);
          return;
        }
        setView(v);
        setMissing(false);
      })
      .catch((e: Error & { status?: number }) => {
        if (e.status === 404) setMissing(true);
      });
  }, [conn]);

  useEffect(() => {
    load();
    const t = window.setInterval(() => {
      setNow(Date.now());
      load();
    }, 2000);
    return () => window.clearInterval(t);
  }, [load]);

  async function post(path: string, body: unknown = {}) {
    setBusy(true);
    try {
      const v = await conn.api<DevicesView>(path, body);
      setView(v);
      return true;
    } catch (e) {
      onMessage((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    try {
      const p = await conn.api<Pairing>("/api/phone/devices/pairing", {});
      setPairing(p);
      setNow(Date.now());
      load();
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.link);
      onMessage("Link copiado. Vale uma vez, por poucos minutos.");
    } catch {
      onMessage("Não deu para copiar. Selecione o link e copie.");
    }
  }

  if (missing) return null;
  const pending = view?.pending ?? 0;
  const state = pairingState(pairing, pending, now);
  const left = pairing ? countdownLabel(pairing.expires_at, now) : null;
  const devices: PhoneDevice[] = view?.devices ?? [];
  const configured = view?.configured ?? false;

  return (
    <section className="mt-6" aria-label="Aparelhos conectados">
      <h2 className="text-[15px] font-semibold text-text-1">Aparelhos conectados</h2>
      <p className="mt-1 max-w-xl text-[13px] text-text-2">
        Abra o QR code com a câmera do celular: ele entra já logado, sem digitar domínio nem senha. O link vale uma vez e por 5 minutos. A senha continua
        existindo como alternativa.
      </p>

      <button
        type="button"
        disabled={busy || !configured}
        className="mt-3 rounded bg-accent px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
        onClick={() => void generate()}
      >
        {state === "idle" ? "Conectar um celular" : "Gerar outro QR code"}
      </button>
      {!configured && <span className="ml-2 text-[12px] text-text-3">Salve a linha do servidor e a senha primeiro.</span>}

      {pairing && state === "waiting" && (
        <div className="mt-3 flex max-w-xl flex-wrap items-start gap-4">
          <img src={pairing.qr} alt="QR code para conectar o celular" width={200} height={200} className="rounded bg-white p-2" />
          <div className="min-w-0 flex-1 text-[13px] text-text-2">
            <p>Vence em {left}. Só vale uma vez.</p>
            <input
              readOnly
              value={pairing.link}
              aria-label="Link para conectar o celular"
              className="mt-2 w-full rounded border border-border bg-bg-term px-2 py-1.5 font-mono text-[12px] text-text-1"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="mt-2 flex gap-2">
              <button type="button" className="rounded border border-border px-2.5 py-1 text-[12px] text-text-1" onClick={() => void copyLink()}>
                Copiar link
              </button>
              <button
                type="button"
                className="rounded border border-border px-2.5 py-1 text-[12px] text-text-1"
                onClick={() => void post("/api/phone/devices/pairing/cancel").then((ok) => ok && setPairing(null))}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
      {state === "used" && <p className="mt-3 text-[13px] text-status-ok">Celular conectado.</p>}
      {state === "expired" && <p className="mt-3 text-[13px] text-text-3">O QR code venceu. Gere outro.</p>}

      <div className="mt-5 max-w-2xl">
        {devices.length === 0 ? (
          <p className="text-[13px] text-text-3">Nenhum celular conectado ainda.</p>
        ) : (
          <ul className="divide-y divide-border rounded border border-border">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <div className="min-w-0 flex-1">
                  {editing?.id === d.id ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void post("/api/phone/devices/rename", { id: d.id, name: editing.name }).then((ok) => ok && setEditing(null));
                      }}
                    >
                      <input
                        autoFocus
                        value={editing.name}
                        maxLength={40}
                        aria-label="Nome do aparelho"
                        className="w-48 rounded border border-border bg-bg-term px-2 py-1 text-[13px] text-text-1"
                        onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                      />
                      <button type="submit" className="rounded bg-accent px-2.5 py-1 text-[12px] text-white">
                        Salvar
                      </button>
                      <button type="button" className="px-1 text-[12px] text-text-2" onClick={() => setEditing(null)}>
                        Cancelar
                      </button>
                    </form>
                  ) : (
                    <p className="truncate text-[13px] text-text-1">{deviceTitle(d)}</p>
                  )}
                  <p className="text-[12px] text-text-3">
                    Conectado em {new Date(d.created).toLocaleDateString("pt-BR")} · último uso {agoLabel(d.last_used, now)}
                    {d.last_ip ? ` · IP ${d.last_ip}` : ""}
                  </p>
                </div>
                {editing?.id !== d.id && (
                  <div className="flex gap-2">
                    <button type="button" className="text-[12px] text-text-2 hover:text-text-1" onClick={() => setEditing({ id: d.id, name: deviceTitle(d) })}>
                      Renomear
                    </button>
                    <button
                      type="button"
                      className="text-[12px] text-status-err"
                      onClick={() => void post("/api/phone/devices/revoke", { id: d.id }).then((ok) => ok && onMessage(`${deviceTitle(d)} desconectado`))}
                    >
                      Revogar
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {devices.length > 0 &&
          (confirmAll ? (
            <p className="mt-2 text-[13px] text-text-1">
              Desconectar todos os celulares agora?{" "}
              <button
                type="button"
                className="text-status-err"
                onClick={() => void post("/api/phone/devices/revoke-all").then((ok) => ok && setConfirmAll(false))}
              >
                Sim, revogar todos
              </button>{" "}
              <button type="button" className="text-text-2" onClick={() => setConfirmAll(false)}>
                Não
              </button>
            </p>
          ) : (
            <button type="button" className="mt-2 text-[12px] text-status-err" onClick={() => setConfirmAll(true)}>
              Revogar todos
            </button>
          ))}
        <p className="mt-2 text-[12px] text-text-3">Trocar a senha do celular não desconecta os aparelhos já conectados. Use Revogar.</p>
      </div>
    </section>
  );
}
