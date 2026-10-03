import { useState, type ReactNode } from "react";
import { Check, Minus, Monitor, Moon, Palette, Plus, RotateCcw, Sun, Wand2, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo, SettingsEvent, ThemeInfo } from "@/lib/types";
import { FACTORY_THEME_NAME, FALLBACK_FAMILY, setDefault, setPane, type Catalog } from "@/lib/appearance";
import { LIGHT, NAVY_DARK, VSCODE_DARK, deriveUI, normalizeUIMode, type UIColors, type UIMode } from "@/lib/uiTheme";
import { paneLabel } from "@/lib/panes";
import { cn } from "@/lib/utils";
import type { NotifyPrefs } from "@/lib/notify";
import { FontPicker, Swatch, ThemePicker } from "./Pickers";



interface Props {
  conn: Connection;
  catalog: Catalog;
  settings: SettingsEvent | null;
  panes: PaneInfo[] | null;
  /** tema padrao efetivo dos terminais ("" = tema embutido) */
  defaultThemeId: string;
  onPreviewUI: (c: UIColors | null) => void;
  onClose: () => void;
  onMessage: (m: string) => void;
  notify: NotifyPrefs;
  onNotify: (p: NotifyPrefs) => void;
  /** abre "Voz e IA" */
  onOpenVoice?: () => void;
  /** dentro da tela de Configuracoes: sem moldura propria */
  embedded?: boolean;
  /** secoes a mostrar (padrao: todas) */
  sections?: ("ui" | "voice" | "notify" | "terminals")[];
}

/** "Aparencia geral": tema da interface + padroes de todos os terminais. */
export function GeneralAppearance({
  conn,
  catalog,
  settings,
  panes,
  defaultThemeId,
  onPreviewUI,
  onClose,
  onMessage,
  notify,
  onNotify,
  onOpenVoice,
  embedded,
  sections,
}: Props) {
  const show = (k: "ui" | "voice" | "notify" | "terminals") => !sections || sections.includes(k);
  const ui = { mode: normalizeUIMode(settings?.ui_theme?.mode), theme_id: settings?.ui_theme?.theme_id };
  const [pickUI, setPickUI] = useState(ui.mode === "theme");
  const [pickTermTheme, setPickTermTheme] = useState(false);
  const [pickFont, setPickFont] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const themes = catalog.themes ?? [];
  const byId = catalog.themeById;
  const followTheme = defaultThemeId ? byId.get(defaultThemeId) : undefined;
  const def = settings?.default ?? {};
  const defFamily = def.font_family || settings?.gui_default_font || FALLBACK_FAMILY;
  const defSize = def.font_size ?? 0;
  const custom = Object.entries(settings?.panes ?? {}).filter(([, p]) => p.theme || p.font_family || p.font_size);
  const live = new Map((panes ?? []).map((p) => [p.pane_id, p]));

  const run = (p: Promise<unknown>, ok?: string) => p.then(() => ok && onMessage(ok)).catch((e: Error) => onMessage(`Erro: ${e.message}`));
  const saveUI = (mode: UIMode, theme_id = "") =>
    run(
      conn.api<SettingsEvent>("/api/settings/ui", { mode, theme_id }).then((s) => conn.setSettings(s)),
      "Tema da interface salvo",
    );
  const preview = (c: UIColors | null) => onPreviewUI(c);
  const derive = (t?: ThemeInfo) => (t ? deriveUI(t) : VSCODE_DARK);

  const body = (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4" onMouseLeave={() => preview(null)}>
          {/* 1. Interface */}
          {show("ui") && (
          <section>
            <H>Tema da interface</H>
            <p className="mb-2 text-[12px] text-text-2">Barra lateral, abas, cabeçalhos, menus, busca e painéis. Passe o mouse para ver antes.</p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5" onMouseLeave={() => preview(null)}>
              <ModeCard
                icon={<Moon size={16} />}
                title="Escuro"
                sub="VS Code Dark Modern"
                active={ui.mode === "dark"}
                onEnter={() => preview(VSCODE_DARK)}
                onClick={() => {
                  setPickUI(false);
                  saveUI("dark");
                }}
              />
              <ModeCard
                icon={<Sun size={16} />}
                title="Claro"
                sub="fundo claro"
                active={ui.mode === "light"}
                onEnter={() => preview(LIGHT)}
                onClick={() => {
                  setPickUI(false);
                  saveUI("light");
                }}
              />
              <ModeCard
                icon={<Moon size={16} />}
                title="Azul-marinho"
                sub="escuro com fundo navy"
                active={ui.mode === "navy"}
                onEnter={() => preview(NAVY_DARK)}
                onClick={() => {
                  setPickUI(false);
                  saveUI("navy");
                }}
              />
              <ModeCard
                icon={<Wand2 size={16} />}
                title="Seguir o tema dos terminais"
                sub={followTheme ? followTheme.name : FACTORY_THEME_NAME}
                active={ui.mode === "follow"}
                onEnter={() => preview(derive(followTheme))}
                onClick={() => { setPickUI(false); saveUI("follow"); }}
              />
              <ModeCard
                icon={<Monitor size={16} />}
                title="Escolher um tema…"
                sub={ui.mode === "theme" ? byId.get(ui.theme_id ?? "")?.name : undefined}
                active={ui.mode === "theme"}
                onEnter={() => ui.mode === "theme" && preview(derive(byId.get(ui.theme_id ?? "")))}
                onClick={() => setPickUI((v) => !v)}
              />
            </div>
            {pickUI && (
              <div className="mt-2">
                <ThemePicker
                  themes={themes}
                  favorites={settings?.theme_favorites ?? []}
                  selectedId={ui.mode === "theme" ? (ui.theme_id ?? "") : ""}
                  onHover={(t) => preview(t ? deriveUI(t) : null)}
                  onPick={(t) => saveUI("theme", t.id)}
                />
              </div>
            )}
          </section>
          )}

          {onOpenVoice && show("voice") && (
            <section>
              <H>Voz e IA</H>
              <p className="mb-2 text-[12px] text-text-2">Microfone: provedor de transcrição, correção por IA, vocabulário do projeto e chaves de API.</p>
              <Btn onClick={onOpenVoice}>Abrir Voz e IA…</Btn>
            </section>
          )}

          {/* Avisos de agente */}
          {show("notify") && (
          <section>
            <H>Avisos de agente aguardando</H>
            <p className="mb-2 text-[12px] text-text-2">
              O ponto âmbar na barra lateral, nas abas e no cabeçalho do terminal aparece sempre. Aqui você liga avisos extras (valem só neste
              computador).
            </p>
            <div className="flex flex-wrap gap-2">
              <Toggle on={notify.os} onClick={() => onNotify({ ...notify, os: !notify.os })} label="Notificação do Windows" />
              <Toggle on={notify.sound} onClick={() => onNotify({ ...notify, sound: !notify.sound })} label="Som" />
            </div>
          </section>
          )}

          {/* 2. Terminais */}
          {show("terminals") && (
          <section>
            <H>Terminais em geral</H>
            <p className="mb-2 text-[12px] text-text-2">Padrão para todos os terminais que não têm tema ou fonte próprios.</p>
            <Row label="Tema padrão">
              {followTheme ? <Swatch t={followTheme} className="h-7 w-20" /> : null}
              <span className="min-w-0 flex-1 truncate text-text-1">
                {followTheme ? followTheme.name : FACTORY_THEME_NAME}
              </span>
              {settings?.gui_default_theme && settings.gui_default_theme !== def.theme && (
                <Btn
                  onClick={() => run(setDefault(conn, { theme: settings.gui_default_theme }), "Tema padrão: o mesmo da GUI")}
                  title="Usar o tema padrão configurado na GUI do Beth Studio"
                >
                  Usar o da GUI ({byId.get(settings.gui_default_theme)?.name ?? settings.gui_default_theme})
                </Btn>
              )}
              {def.theme && (
                <Btn onClick={() => run(setDefault(conn, { theme: "" }), `Tema padrão: ${FACTORY_THEME_NAME}`)} title="Voltar ao padrão de fábrica do web">
                  Padrão de fábrica
                </Btn>
              )}
              <Btn onClick={() => setPickTermTheme((v) => !v)}>{pickTermTheme ? "Fechar lista" : "Trocar…"}</Btn>
            </Row>
            {pickTermTheme && (
              <div className="mb-2">
                <ThemePicker
                  themes={themes}
                  favorites={settings?.theme_favorites ?? []}
                  selectedId={defaultThemeId}
                  onHover={() => undefined}
                  onPick={(t) => run(setDefault(conn, { theme: t.id }), `Tema padrão: ${t.name}`)}
                />
              </div>
            )}
            <Row label="Fonte padrão">
              <span className="min-w-0 flex-1 truncate text-text-1" style={{ fontFamily: `"${defFamily}", monospace` }}>
                {defFamily}
              </span>
              <Btn onClick={() => setPickFont((v) => !v)}>{pickFont ? "Fechar lista" : "Trocar…"}</Btn>
            </Row>
            {pickFont && (
              <div className="mb-2">
                <FontPicker
                  fonts={catalog.fonts ?? []}
                  favorites={settings?.font_favorites ?? []}
                  selected={defFamily}
                  onPick={(f) => run(setDefault(conn, { font_family: f }), `Fonte padrão: ${f}`)}
                />
              </div>
            )}
            <Row label="Tamanho padrão">
              <button
                className={cn("rounded-full px-2.5 py-0.5 text-[12px]", defSize === 0 ? "bg-accent text-white" : "bg-bg-hover text-text-2 hover:text-text-1")}
                onClick={() => run(setDefault(conn, { font_size: 0 }))}
              >
                Automático
              </button>
              <div className="flex items-center overflow-hidden rounded border border-border">
                <button className="p-1 text-text-2 hover:bg-bg-hover" title="Diminuir" onClick={() => run(setDefault(conn, { font_size: Math.max(5, (defSize || 14) - 1) }))}>
                  <Minus size={13} />
                </button>
                <span className="w-12 text-center font-mono text-text-1">{defSize || "auto"}</span>
                <button className="p-1 text-text-2 hover:bg-bg-hover" title="Aumentar" onClick={() => run(setDefault(conn, { font_size: Math.min(48, (defSize || 13) + 1) }))}>
                  <Plus size={13} />
                </button>
              </div>
            </Row>

            <div className="mt-3 flex items-center gap-2">
              <div className="flex-1 text-[12px] text-text-2">
                {custom.length === 0 ? "Nenhum terminal tem tema ou fonte próprios." : `${custom.length} terminal(is) com tema ou fonte próprios:`}
              </div>
              <Btn
                disabled={custom.length === 0}
                onClick={() => setConfirm(true)}
                title="Remove o tema, a fonte e o tamanho próprios de todos os terminais"
              >
                Aplicar o padrão a todos
              </Btn>
            </div>
            {confirm && (
              <div className="mt-2 flex items-center gap-2 rounded border border-status-warn/50 bg-status-warn/10 p-2 text-[12px] text-text-1">
                <span className="flex-1">
                  Remover o tema/fonte próprios de <b>{custom.length}</b> terminal(is)? Eles passam a usar o padrão.
                </span>
                <Btn onClick={() => setConfirm(false)}>Cancelar</Btn>
                <button
                  className="rounded bg-accent px-3 py-1 text-white hover:bg-accent-hover"
                  onClick={() => {
                    setConfirm(false);
                    run(
                      conn.api<{ cleared: number; settings: SettingsEvent }>("/api/settings/clear-panes", {}).then((r) => {
                        conn.setSettings(r.settings);
                        onMessage(`${r.cleared} terminal(is) voltaram ao padrão`);
                      }),
                    );
                  }}
                >
                  Sim, aplicar a todos
                </button>
              </div>
            )}
            <ul className="mt-2 space-y-1">
              {custom.map(([id, p]) => {
                const info = live.get(Number(id));
                const th = p.theme ? byId.get(p.theme)?.name ?? p.theme : null;
                return (
                  <li key={id} className="flex items-center gap-2 rounded bg-bg-panel px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-text-1">{info ? paneLabel(info) : p.title || `Terminal ${id}`}</div>
                      <div className="flex flex-wrap gap-1 text-[11px] text-text-2">
                        {th && <Chip>tema: {th}</Chip>}
                        {p.font_family && <Chip>fonte: {p.font_family}</Chip>}
                        {p.font_size ? <Chip>tamanho: {p.font_size}</Chip> : null}
                      </div>
                    </div>
                    <Btn onClick={() => run(setPane(conn, Number(id), { theme: "", font_family: "", font_size: 0 }), "Terminal voltou ao padrão")}>
                      <RotateCcw size={12} /> Voltar ao padrão
                    </Btn>
                  </li>
                );
              })}
            </ul>
          </section>
          )}
        </div>
  );
  if (embedded) return body;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[5vh]" onMouseDown={onClose}>
      <div
        className="flex max-h-[90vh] w-[min(780px,94vw)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseLeave={() => preview(null)}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Palette size={16} className="text-accent-text" />
          <div className="flex-1 text-[15px] font-semibold text-text-1">Aparência geral</div>
          <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      className={cn("flex items-center gap-2 rounded-md border px-3 py-1.5 text-[12px]", on ? "border-accent bg-accent-soft text-text-1" : "border-border bg-bg-panel text-text-2 hover:text-text-1")}
      onClick={onClick}
    >
      <span className={cn("relative h-4 w-7 rounded-full transition-colors", on ? "bg-accent" : "bg-border-strong")}>
        <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all", on ? "left-3.5" : "left-0.5")} />
      </span>
      {label}
    </button>
  );
}

function H({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">{children}</div>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="w-32 shrink-0 text-text-2">{label}</span>
      {children}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded bg-bg-hover px-1.5">{children}</span>;
}

function Btn({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      className="flex shrink-0 items-center gap-1 rounded bg-bg-hover px-2.5 py-1 text-[12px] text-text-1 hover:bg-border disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function ModeCard(p: { icon: ReactNode; title: string; sub?: string; active: boolean; onEnter: () => void; onClick: () => void }) {
  return (
    <button
      className={cn(
        "flex flex-col items-start gap-1 rounded-md border p-2.5 text-left",
        p.active ? "border-accent bg-accent-soft" : "border-border bg-bg-panel hover:bg-bg-hover",
      )}
      onMouseEnter={p.onEnter}
      onClick={p.onClick}
    >
      <span className="flex items-center gap-1.5 text-text-1">
        {p.icon}
        {p.active && <Check size={13} className="text-accent-text" />}
      </span>
      <span className="text-[12px] font-semibold text-text-1">{p.title}</span>
      {p.sub && <span className="max-w-full truncate text-[11px] text-text-3">{p.sub}</span>}
    </button>
  );
}
