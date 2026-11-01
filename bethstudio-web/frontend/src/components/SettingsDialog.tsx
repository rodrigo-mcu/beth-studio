import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Cable, CircleDollarSign, Eraser, Database, FolderOpen, Info, KeyRound, LayoutGrid, Mic, Monitor, PanelLeft, Settings, Smartphone, TerminalSquare, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo, SettingsEvent } from "@/lib/types";
import { setDefault, type Catalog } from "@/lib/appearance";
import type { UIColors } from "@/lib/uiTheme";
import type { NotifyPrefs } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { KIND_LABEL, kindOrder, moveItem } from "@/lib/kinds";
import { GeneralAppearance } from "./GeneralAppearance";
import { WslInitSettings } from "./WslInitSettings";
import { VoiceSettingsDialog } from "./VoiceSettingsDialog";
import { AIUsageSection } from "./AIUsage";
import { DbAssistSettings } from "./DbAssistSettings";
import { PhoneRemoteSection } from "./PhoneRemoteSection";
import { PhoneDevicesSection } from "./PhoneDevicesSection";
import { VpsInstallWizard } from "./VpsInstallWizard";
import { RemoteStudioSection } from "./RemoteStudioSection";
import { UpdateSection } from "./UpdateSection";
import { PerformanceSection } from "./PerformanceSection";
import { TempCleanSection } from "./TempCleanSection";
import { PonteSection } from "./PonteSection";
import { isRemote } from "@/lib/remote";

export type SettingsSection = "aparencia" | "terminais" | "celular" | "voz" | "provedores" | "ponte" | "temp" | "banco" | "uso" | "barra" | "sobre";

interface SidebarPrefs {
  collapsed: boolean;
  width: number;
  view?: string;
  kinds?: string[];
  kind_order?: string[];
  split_by_kind?: boolean;
}

interface Props {
  conn: Connection;
  catalog: Catalog;
  settings: SettingsEvent | null;
  panes: PaneInfo[] | null;
  defaultThemeId: string;
  onPreviewUI: (c: UIColors | null) => void;
  onMessage: (m: string) => void;
  notify: NotifyPrefs;
  onNotify: (p: NotifyPrefs) => void;
  sidebar: SidebarPrefs;
  saveSidebar: (p: Partial<SidebarPrefs>) => void;
  initialSection?: SettingsSection;
  onClose: () => void;
}

const NAV: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "aparencia", label: "Aparência", icon: <Monitor size={15} /> },
  { id: "terminais", label: "Terminais", icon: <TerminalSquare size={15} /> },
  { id: "celular", label: "Celular", icon: <Smartphone size={15} /> },
  { id: "voz", label: "Voz e IA", icon: <Mic size={15} /> },
  { id: "provedores", label: "Provedores de IA", icon: <KeyRound size={15} /> },
  { id: "ponte", label: "Ponte de agentes", icon: <Cable size={15} /> },
  { id: "temp", label: "Arquivos temporários", icon: <Eraser size={15} /> },
  { id: "banco", label: "Banco de dados", icon: <Database size={15} /> },
  { id: "uso", label: "Uso e custos de IA", icon: <CircleDollarSign size={15} /> },
  { id: "barra", label: "Barra lateral", icon: <PanelLeft size={15} /> },
  { id: "sobre", label: "Sobre", icon: <Info size={15} /> },
];

/** Tela unica de Configuracoes, com navegacao lateral por secoes. */
export function SettingsDialog(p: Props) {
  const [sec, setSec] = useState<SettingsSection>(p.initialSection ?? "aparencia");
  const common = {
    conn: p.conn,
    catalog: p.catalog,
    settings: p.settings,
    panes: p.panes,
    defaultThemeId: p.defaultThemeId,
    onPreviewUI: p.onPreviewUI,
    onClose: p.onClose,
    onMessage: p.onMessage,
    notify: p.notify,
    onNotify: p.onNotify,
    embedded: true,
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[4vh]" onMouseDown={p.onClose}>
      <div
        className="flex h-[88vh] w-[min(1040px,96vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && p.onClose()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Settings size={16} className="text-accent-text" />
          <div className="flex-1 text-[15px] font-semibold text-text-1">Configurações</div>
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={p.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav className="w-48 shrink-0 space-y-0.5 border-r border-border bg-bg-panel p-2">
            {NAV.map((n) => (
              <button
                key={n.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px]",
                  sec === n.id ? "bg-accent-soft font-semibold text-text-1" : "text-text-2 hover:bg-bg-hover hover:text-text-1",
                )}
                onClick={() => setSec(n.id)}
              >
                {n.icon}
                {n.label}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {sec === "aparencia" && <GeneralAppearance {...common} sections={["ui", "terminals"]} />}
            {sec === "terminais" && (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <TerminalsSection conn={p.conn} settings={p.settings} onMessage={p.onMessage} />
                <PerformanceSection conn={p.conn} onMessage={p.onMessage} />
                {!isRemote() && <WslInitSettings conn={p.conn} onMessage={p.onMessage} />}
                <GeneralAppearance {...common} sections={["notify"]} />
              </div>
            )}
            {sec === "celular" &&
              (isRemote() ? (
                <div className="px-5 py-4 text-[13px] text-text-2">O celular e o acesso remoto se configuram só no Studio do PC.</div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <PhoneRemoteSection conn={p.conn} onMessage={p.onMessage} />
                  <div className="px-5">
                    <VpsInstallWizard conn={p.conn} onMessage={p.onMessage} />
                  </div>
                  <div className="px-5 pb-6">
                    <PhoneDevicesSection conn={p.conn} onMessage={p.onMessage} />
                    <RemoteStudioSection conn={p.conn} onMessage={p.onMessage} />
                  </div>
                </div>
              ))}
            {sec === "voz" && <VoiceSettingsDialog key="voz" conn={p.conn} onClose={p.onClose} initialTab="voz" embedded />}
            {sec === "provedores" && <VoiceSettingsDialog key="prov" conn={p.conn} onClose={p.onClose} initialTab="provedores" embedded />}
            {sec === "ponte" &&
              (isRemote() ? (
                <div className="px-5 py-4 text-[13px] text-text-2">A ponte de agentes se configura só no Studio do PC.</div>
              ) : (
                <PonteSection conn={p.conn} onMessage={p.onMessage} />
              ))}
            {sec === "temp" &&
              (isRemote() ? (
                <div className="px-5 py-4 text-[13px] text-text-2">A limpeza de temporários se configura só no Studio do PC.</div>
              ) : (
                <TempCleanSection conn={p.conn} onMessage={p.onMessage} />
              ))}
            {sec === "banco" &&<DbAssistSettings conn={p.conn} onProviders={() => setSec("provedores")} />}
            {sec === "uso" && <AIUsageSection conn={p.conn} onMessage={p.onMessage} />}
            {sec === "barra" && <SidebarSection sidebar={p.sidebar} save={p.saveSidebar} />}
            {sec === "sobre" && <AboutSection conn={p.conn} onMessage={p.onMessage} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function H({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">{children}</div>;
}

function Choice({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub?: string }) {
  return (
    <button
      className={cn(
        "flex w-full items-start gap-2 rounded-md border p-2.5 text-left",
        on ? "border-accent bg-accent-soft" : "border-border bg-bg-panel hover:bg-bg-hover",
      )}
      onClick={onClick}
    >
      <span className={cn("mt-1 h-3 w-3 shrink-0 rounded-full border-2", on ? "border-accent bg-accent" : "border-border-strong")} />
      <span>
        <span className="block text-[13px] text-text-1">{title}</span>
        {sub && <span className="block text-[11px] text-text-3">{sub}</span>}
      </span>
    </button>
  );
}

function TerminalsSection({ conn, settings, onMessage }: { conn: Connection; settings: SettingsEvent | null; onMessage: (m: string) => void }) {
  const mode = settings?.default?.size_mode || "fit";
  const set = (m: "fit" | "host") =>
    void setDefault(conn, { size_mode: m })
      .then(() => onMessage("Padrão de tamanho salvo"))
      .catch((e: Error) => onMessage(`Erro: ${e.message}`));
  return (
    <div className="space-y-5 p-4 pb-0">
      <section>
        <H>Tamanho dos terminais</H>
        <p className="mb-2 text-[12px] text-text-2">
          Padrão para terminais sozinhos na aba do Beth Studio (cada terminal pode mudar no ⤢/🖥 do cabeçalho). Terminais em split no Beth Studio usam “Igual
          ao Beth Studio” — ou “Separar no Beth Studio” para ajustar.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <Choice
            on={mode === "fit"}
            onClick={() => set("fit")}
            title="Ajustar à janela"
            sub="o terminal muda de colunas×linhas para caber aqui (também no Beth Studio)"
          />
          <Choice
            on={mode === "host"}
            onClick={() => set("host")}
            title="Igual ao Beth Studio"
            sub="mostra o tamanho que o terminal tem na GUI; a fonte se ajusta"
          />
        </div>
      </section>
      <section>
        <H>Fonte</H>
        <p className="text-[12px] text-text-2">
          Em “Igual ao Beth Studio” a fonte é automática (preenche a área), a não ser que você fixe o tamanho naquele terminal com A−/A+. A família, o
          tamanho padrão e o negrito ficam em Aparência → Terminais em geral.
        </p>
      </section>
      <section>
        <H>Clique num terminal</H>
        <p className="text-[12px] text-text-2">
          Se o terminal já está numa aba do web, abre essa aba; senão abre numa aba nova só com ele (nunca substitui o terminal em foco). “Abrir ao
          lado” continua no ícone de colunas. Fechar uma aba nunca encerra o terminal.
        </p>
      </section>
    </div>
  );
}

function SidebarSection({ sidebar, save }: { sidebar: SidebarPrefs; save: (p: Partial<SidebarPrefs>) => void }) {
  const view = sidebar.view || "web";
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      <section>
        <H>Visão</H>
        <div className="grid gap-2 md:grid-cols-4">
          <Choice on={view === "web"} onClick={() => save({ view: "web" })} title="Minha organização" sub="abas do web e não organizados" />
          <Choice on={view === "host"} onClick={() => save({ view: "host" })} title="Como no Beth Studio" sub="janela → aba → terminal" />
          <Choice on={view === "kind"} onClick={() => save({ view: "kind" })} title="Por tipo" sub="WSL, PowerShell, cmd…" />
          <Choice on={view === "folder"} onClick={() => save({ view: "folder" })} title="Por pasta" sub="agrupa pela pasta atual de cada terminal" />
        </div>
      </section>
      <section>
        <H>Filtro por tipo</H>
        <p className="mb-2 text-[12px] text-text-2">
          {sidebar.kinds?.length ? `Filtrando: ${sidebar.kinds.join(", ")}` : "Sem filtro (todos os tipos)."} Os filtros ficam nos botões abaixo da
          busca, na barra lateral.
        </p>
        {!!sidebar.kinds?.length && (
          <button className="rounded bg-bg-hover px-3 py-1 text-[12px] text-text-1 hover:bg-border" onClick={() => save({ kinds: [] })}>
            Limpar filtro
          </button>
        )}
      </section>
      <section>
        <H>Tipos de terminal</H>
        <label className="mb-2 flex items-center gap-2 text-[12px] text-text-1">
          <input type="checkbox" checked={sidebar.split_by_kind !== false} onChange={(e) => save({ split_by_kind: e.target.checked })} />
          Separar por tipo em “Não organizados” e “Como no Beth Studio”
        </label>
        <p className="mb-1 text-[12px] text-text-2">Ordem dos grupos (vale para as listas, “Por tipo” e os filtros):</p>
        <ol className="max-w-xs space-y-0.5">
          {kindOrder(sidebar.kind_order).map((k, i, all) => (
            <li key={k} className="flex items-center gap-1 rounded bg-bg-panel px-2 py-1 text-[12px] text-text-1">
              <span className="w-4 text-text-3">{i + 1}.</span>
              <span className="flex-1">{KIND_LABEL[k]}</span>
              <button
                className="rounded p-0.5 text-text-2 hover:bg-bg-hover disabled:opacity-30"
                disabled={i === 0}
                title="Subir"
                onClick={() => save({ kind_order: moveItem(all, i, i - 1) })}
              >
                <ArrowUp size={13} />
              </button>
              <button
                className="rounded p-0.5 text-text-2 hover:bg-bg-hover disabled:opacity-30"
                disabled={i === all.length - 1}
                title="Descer"
                onClick={() => save({ kind_order: moveItem(all, i, i + 1) })}
              >
                <ArrowDown size={13} />
              </button>
            </li>
          ))}
        </ol>
        {!!sidebar.kind_order?.length && (
          <button className="mt-1 rounded bg-bg-hover px-3 py-1 text-[12px] text-text-1 hover:bg-border" onClick={() => save({ kind_order: [] })}>
            Ordem padrão
          </button>
        )}
      </section>
      <section>
        <H>Largura e visibilidade</H>
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded bg-bg-hover px-3 py-1 text-[12px] text-text-1 hover:bg-border"
            onClick={() => save({ collapsed: !sidebar.collapsed })}
          >
            {sidebar.collapsed ? "Mostrar a barra lateral" : "Recolher a barra lateral"}
          </button>
          <button className="rounded bg-bg-hover px-3 py-1 text-[12px] text-text-1 hover:bg-border" onClick={() => save({ width: 288 })}>
            Largura padrão (atual: {sidebar.width}px)
          </button>
        </div>
        <p className="mt-1 text-[11px] text-text-3">Dica: arraste a borda direita da barra lateral para mudar a largura.</p>
      </section>
    </div>
  );
}

interface About {
  version: string;
  api_level?: number;
  ui_version?: string;
  ui_override?: boolean;
  ui_note?: string;
  build_time: string;
  exe: string;
  exe_time: string;
  go: string;
  bridge_exe: string;
  bridge_time: string;
  data_dir: string;
  read_only: boolean;
  files: { id: string; label: string; path: string; exists: boolean }[];
}

function AboutSection({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [a, setA] = useState<About | null>(null);
  useEffect(() => {
    void conn
      .api<About>("/api/about")
      .then(setA)
      .catch((e: Error) => onMessage(`Erro: ${e.message}`));
  }, [conn, onMessage]);
  const fmt = (t: string) => (t ? new Date(t).toLocaleString("pt-BR") : "—");
  if (!a) return <div className="p-4 text-text-2">Carregando…</div>;
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      <section>
        <H>Beth Studio</H>
        <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-[12px]">
          <span className="text-text-2">Versão</span>
          <span className="text-text-1">
            {a.version} · build {fmt(a.build_time || a.exe_time)} · {a.go}
            {a.read_only && " · somente leitura"}
          </span>
          <span className="text-text-2">Interface</span>
          <span className="text-text-1">
            {a.ui_override ? `pacote ${a.ui_version}` : "embutida no executável"}
            {a.api_level != null && <span className="text-text-3"> · API {a.api_level}</span>}
            {a.ui_note && <span className="text-text-3"> · pacote ignorado: {a.ui_note}</span>}
            <button
              className="ml-3 rounded bg-bg-hover px-2 py-0.5 text-text-1 hover:bg-border"
              title="Recarrega a interface (aplica um pacote novo, sem reiniciar o Studio nem o host)"
              onClick={() => window.location.reload()}
            >
              Recarregar interface
            </button>
          </span>
          <span className="text-text-2">Executável</span>
          <span className="break-all font-mono text-[11px] text-text-1">{a.exe}</span>
          <span className="text-text-2">Ponte (bethstudio.exe)</span>
          <span className="break-all font-mono text-[11px] text-text-1">
            {a.bridge_exe} <span className="font-sans text-text-3">· {fmt(a.bridge_time)}</span>
          </span>
          <span className="text-text-2">Pasta de dados</span>
          <span className="break-all font-mono text-[11px] text-text-1">{a.data_dir}</span>
        </div>
      </section>
      <UpdateSection conn={conn} readOnly={a.read_only} />
      <section>
        <H>Arquivos</H>
        <ul className="space-y-1">
          {a.files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded bg-bg-panel px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-text-1">{f.label}</div>
                <div className={cn("truncate font-mono text-[11px]", f.exists ? "text-text-2" : "text-text-3")} title={f.path}>
                  {f.path}
                  {!f.exists && " (ainda não existe)"}
                </div>
              </div>
              <button
                className="flex shrink-0 items-center gap-1 rounded bg-bg-hover px-2 py-1 text-[12px] text-text-1 hover:bg-border"
                onClick={() => void conn.api("/api/about", { id: f.id }).catch((e: Error) => onMessage(`Erro: ${e.message}`))}
              >
                <FolderOpen size={12} /> Abrir pasta
              </button>
            </li>
          ))}
        </ul>
      </section>
      <p className="flex items-center gap-1 text-[11px] text-text-3">
        <LayoutGrid size={11} /> Chaves de API ficam cifradas pelo Windows (DPAPI) e nunca aparecem aqui.
      </p>
    </div>
  );
}
