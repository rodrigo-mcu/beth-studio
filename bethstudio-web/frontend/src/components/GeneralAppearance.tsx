import { useState, type ReactNode } from "react";
import { Check, Minus, Monitor, Moon, Palette, Plus, RotateCcw, Sun, Wand2, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { PaneInfo, SettingsEvent, ThemeInfo } from "@/lib/types";
import { FACTORY_THEME_NAME, FALLBACK_FAMILY, setDefault, setPane, type Catalog } from "@/lib/appearance";
import { LIGHT, NAVY_DARK, VSCODE_DARK, deriveUI, normalizeUIMode, type UIColors, type UIMode } from "@/lib/uiTheme";
import { paneLabel } from "@/lib/panes";
import { cn } from "@/lib/utils";
import { isDefaultZoom, resetPageZoom, usePageZoom, zoomLabel } from "@/lib/pageZoom";
import { isMacTitlebar, isWinAcrylicHost, winCommand } from "@/lib/windowFrame";
import { applyGlassPatch, glassSlidersVisible, vibrancyClick, vibrancyShownAfterSave } from "@/lib/appearanceTune";
import type { NotifyPrefs } from "@/lib/notify";
import { FontPicker, Swatch, ThemePicker } from "./Pickers";
import {
  SettingsBtn,
  SettingsGroup,
  SettingsHint,
  SettingsPage,
  SettingsPanel,
  SettingsRow,
  SettingsSectionLabel,
  SettingsSwitch,
} from "./settings/SettingsUI";

interface Props {
  conn: Connection;
  catalog: Catalog;
  settings: SettingsEvent | null;
  panes: PaneInfo[] | null;
  defaultThemeId: string;
  onPreviewUI: (c: UIColors | null) => void;
  onClose: () => void;
  onMessage: (m: string) => void;
  notify: NotifyPrefs;
  onNotify: (p: NotifyPrefs) => void;
  onOpenVoice?: () => void;
  embedded?: boolean;
  sections?: ("ui" | "voice" | "notify" | "terminals")[];
  pageTitle?: string;
  pageSubtitle?: string;
  /** Bloco mostrado antes do tema (ex.: Estilo da interface). */
  before?: ReactNode;
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
  pageTitle,
  pageSubtitle,
  before,
}: Props) {
  const show = (k: "ui" | "voice" | "notify" | "terminals") => !sections || sections.includes(k);
  const ui = { mode: normalizeUIMode(settings?.ui_theme?.mode), theme_id: settings?.ui_theme?.theme_id };
  const [pickUI, setPickUI] = useState(ui.mode === "theme");
  const [pendingVibrancy, setPendingVibrancy] = useState<boolean | null>(null);
  const vibrancyOn = pendingVibrancy !== null ? pendingVibrancy : vibrancyShownAfterSave(settings?.ui_theme, false);
  const [pickTermTheme, setPickTermTheme] = useState(false);
  const [pickFont, setPickFont] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const themes = catalog.themes ?? [];
  const byId = catalog.themeById;
  const followTheme = defaultThemeId ? byId.get(defaultThemeId) : undefined;
  const def = settings?.default ?? {};
  const defFamily = def.font_family || settings?.gui_default_font || FALLBACK_FAMILY;
  const defSize = def.font_size ?? 0;
  const pageZoom = usePageZoom();
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

  const toggleMaterial = () => {
    const on = vibrancyClick(vibrancyOn).next;
    setPendingVibrancy(on);
    localStorage.setItem("bethstudio-vibrancy", on ? "1" : "0");
    if (isWinAcrylicHost()) {
      document.documentElement.classList.toggle("bt-acrylic", on);
      document.documentElement.classList.remove("bt-vibrancy");
      winCommand(on ? "acrylic:1" : "acrylic:0");
    } else {
      document.documentElement.classList.toggle("bt-vibrancy", on);
      document.documentElement.classList.remove("bt-acrylic");
      const w = window as unknown as {
        webkit?: { messageHandlers?: { bethVibrancy?: { postMessage: (v: string) => void } } };
      };
      w.webkit?.messageHandlers?.bethVibrancy?.postMessage(on ? "1" : "0");
    }
    // Tema claro pode ficar ligado: na barra o CSS/nativo forçam texto claro
    // no vidro pra não sumir (preto no glass).
    conn
      .api<SettingsEvent>("/api/settings/ui", { vibrancy: on })
      .then((s) => {
        setPendingVibrancy(null);
        conn.setSettings(s);
      })
      .catch(() => undefined);
  };

  const body = (
    <div className={cn(!pageTitle && "space-y-5", !pageTitle && (embedded ? "p-0" : ""), !embedded && "min-h-0 flex-1 space-y-5 overflow-y-auto p-4")} onMouseLeave={() => preview(null)}>
      {before}
      {show("ui") && (
        <div className="space-y-5">
          <div>
            <SettingsSectionLabel>Tema da interface</SettingsSectionLabel>
            <SettingsHint className="mb-2">
              Barra lateral, abas, cabeçalhos, menus, busca e painéis. Passe o mouse para ver antes.
              {vibrancyOn && (isMacTitlebar() || isWinAcrylicHost())
                ? ` Com ${isWinAcrylicHost() ? "Acrylic" : "Vibrancy"}, o texto da barra fica claro no vidro (mesmo no tema claro).`
                : ""}
            </SettingsHint>
            <div className="bt-settings-choice-grid" onMouseLeave={() => preview(null)}>
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
                onClick={() => {
                  setPickUI(false);
                  saveUI("follow");
                }}
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
              <SettingsPanel className="mt-2">
                <ThemePicker
                  themes={themes}
                  favorites={settings?.theme_favorites ?? []}
                  selectedId={ui.mode === "theme" ? (ui.theme_id ?? "") : ""}
                  onHover={(t) => preview(t ? deriveUI(t) : null)}
                  onPick={(t) => saveUI("theme", t.id)}
                />
              </SettingsPanel>
            )}
          </div>

          {(isMacTitlebar() || isWinAcrylicHost()) && (
            <div>
              <SettingsSectionLabel>{isWinAcrylicHost() ? "Acrylic" : "Vibrancy"}</SettingsSectionLabel>
              <SettingsGroup>
                <SettingsRow
                  label={isWinAcrylicHost() ? "Acrylic na barra lateral" : "Vibrancy na barra lateral"}
                  hint={
                    isWinAcrylicHost()
                      ? "Só a barra; botões meio translúcidos, sem liquid glass."
                      : "O material do macOS aparece atrás da barra."
                  }
                >
                  <VibrancySample on={vibrancyOn} />
                  <SettingsSwitch
                    on={vibrancyOn}
                    onChange={() => toggleMaterial()}
                    label={isWinAcrylicHost() ? "Acrylic" : "Vibrancy"}
                  />
                </SettingsRow>
              </SettingsGroup>
              {isMacTitlebar() && glassSlidersVisible(vibrancyOn) && (
                <div className="mt-2">
                  <GlassTune settings={settings} conn={conn} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {onOpenVoice && show("voice") && (
        <div>
          <SettingsSectionLabel>Voz e IA</SettingsSectionLabel>
          <SettingsGroup>
            <SettingsRow label="Microfone e provedores" hint="Transcrição, correção por IA, vocabulário e chaves.">
              <SettingsBtn onClick={onOpenVoice}>Abrir…</SettingsBtn>
            </SettingsRow>
          </SettingsGroup>
        </div>
      )}

      {show("notify") && (
        <div>
          <SettingsSectionLabel>Avisos de agente</SettingsSectionLabel>
          <SettingsHint className="mb-2">
            Na lista da esquerda o chat mostra rodando, pronto ou aguardando. O ponto âmbar nas abas aparece sempre. Aqui ligam avisos extras deste computador.
          </SettingsHint>
          <SettingsGroup>
            <SettingsRow
              label={typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "Notificar quando aguardar" : "Notificar quando aguardar"}
              hint="Aviso do sistema quando o agente pede resposta."
            >
              <SettingsSwitch on={notify.os} onChange={(on) => onNotify({ ...notify, os: on })} label="Notificar quando aguardar" />
            </SettingsRow>
            <SettingsRow label="Notificar quando ficar pronto" hint="Quando o chat sai de rodando e o agente termina o turno.">
              <SettingsSwitch on={notify.ready} onChange={(on) => onNotify({ ...notify, ready: on })} label="Notificar quando ficar pronto" />
            </SettingsRow>
            <SettingsRow label="Som">
              <SettingsSwitch on={notify.sound} onChange={(on) => onNotify({ ...notify, sound: on })} label="Som" />
            </SettingsRow>
          </SettingsGroup>
        </div>
      )}

      {show("terminals") && (
        <div>
          <SettingsSectionLabel>Terminais em geral</SettingsSectionLabel>
          <SettingsHint className="mb-2">Padrão para terminais sem tema ou fonte próprios.</SettingsHint>
          <SettingsGroup>
            <SettingsRow
              label="Tema padrão"
              hint={followTheme ? followTheme.name : FACTORY_THEME_NAME}
            >
              {followTheme ? <Swatch t={followTheme} className="h-6 w-14" /> : null}
              {settings?.gui_default_theme && settings.gui_default_theme !== def.theme && (
                <SettingsBtn
                  onClick={() => run(setDefault(conn, { theme: settings.gui_default_theme }), "Tema padrão: o mesmo da GUI")}
                  title="Usar o tema padrão da GUI"
                >
                  GUI
                </SettingsBtn>
              )}
              {def.theme && (
                <SettingsBtn onClick={() => run(setDefault(conn, { theme: "" }), `Tema padrão: ${FACTORY_THEME_NAME}`)}>
                  Fábrica
                </SettingsBtn>
              )}
              <SettingsBtn onClick={() => setPickTermTheme((v) => !v)}>{pickTermTheme ? "Fechar" : "Trocar…"}</SettingsBtn>
            </SettingsRow>
            {pickTermTheme && (
              <div className="px-3 pb-3">
                <ThemePicker
                  themes={themes}
                  favorites={settings?.theme_favorites ?? []}
                  selectedId={defaultThemeId}
                  onHover={() => undefined}
                  onPick={(t) => run(setDefault(conn, { theme: t.id }), `Tema padrão: ${t.name}`)}
                />
              </div>
            )}
            <SettingsRow label="Fonte padrão" hint={<span style={{ fontFamily: `"${defFamily}", monospace` }}>{defFamily}</span>}>
              <SettingsBtn onClick={() => setPickFont((v) => !v)}>{pickFont ? "Fechar" : "Trocar…"}</SettingsBtn>
            </SettingsRow>
            {pickFont && (
              <div className="px-3 pb-3">
                <FontPicker
                  fonts={catalog.fonts ?? []}
                  favorites={settings?.font_favorites ?? []}
                  selected={defFamily}
                  onPick={(f) => run(setDefault(conn, { font_family: f }), `Fonte padrão: ${f}`)}
                />
              </div>
            )}
            <SettingsRow label="Tamanho padrão">
              <SettingsBtn
                tone={defSize === 0 ? "accent" : "neutral"}
                onClick={() => run(setDefault(conn, { font_size: 0 }))}
              >
                Automático
              </SettingsBtn>
              <div className="flex items-center overflow-hidden bt-field">
                <button
                  type="button"
                  className="p-1 text-text-2 hover:bg-bg-hover"
                  title="Diminuir"
                  onClick={() => run(setDefault(conn, { font_size: Math.max(5, (defSize || 14) - 1) }))}
                >
                  <Minus size={13} />
                </button>
                <span className="w-12 text-center font-mono text-text-1">{defSize || "auto"}</span>
                <button
                  type="button"
                  className="p-1 text-text-2 hover:bg-bg-hover"
                  title="Aumentar"
                  onClick={() => run(setDefault(conn, { font_size: Math.min(48, (defSize || 13) + 1) }))}
                >
                  <Plus size={13} />
                </button>
              </div>
            </SettingsRow>
            <SettingsRow label="Zoom da tela" hint={zoomLabel(pageZoom)}>
              <SettingsBtn disabled={isDefaultZoom(pageZoom)} onClick={resetPageZoom} title="Volta a 100% (Ctrl+0)">
                100%
              </SettingsBtn>
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup className="mt-3">
            <SettingsRow
              label="Terminais com aparência própria"
              hint={custom.length === 0 ? "Nenhum." : `${custom.length} terminal(is).`}
            >
              <SettingsBtn
                disabled={custom.length === 0}
                onClick={() => setConfirm(true)}
                title="Remove tema/fonte próprios de todos"
              >
                Aplicar o padrão a todos
              </SettingsBtn>
            </SettingsRow>
            {confirm && (
              <div className="flex items-center gap-2 px-3 pb-3 text-[12px] text-text-1">
                <span className="flex-1">
                  Remover o tema/fonte próprios de <b>{custom.length}</b> terminal(is)?
                </span>
                <SettingsBtn onClick={() => setConfirm(false)}>Cancelar</SettingsBtn>
                <SettingsBtn
                  tone="accent"
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
                  Sim
                </SettingsBtn>
              </div>
            )}
            {custom.map(([id, p]) => {
              const info = live.get(Number(id));
              const th = p.theme ? byId.get(p.theme)?.name ?? p.theme : null;
              return (
                <SettingsRow
                  key={id}
                  label={info ? paneLabel(info) : p.title || `Terminal ${id}`}
                  hint={[th && `tema: ${th}`, p.font_family && `fonte: ${p.font_family}`, p.font_size ? `tamanho: ${p.font_size}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <SettingsBtn onClick={() => run(setPane(conn, Number(id), { theme: "", font_family: "", font_size: 0 }), "Terminal voltou ao padrão")}>
                    <RotateCcw size={12} /> Padrão
                  </SettingsBtn>
                </SettingsRow>
              );
            })}
          </SettingsGroup>
        </div>
      )}
    </div>
  );

  if (embedded) {
    if (pageTitle) {
      return (
        <SettingsPage title={pageTitle} subtitle={pageSubtitle}>
          {body}
        </SettingsPage>
      );
    }
    return body;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[5vh]" onMouseDown={onClose}>
      <div
        className="flex max-h-[90vh] w-[min(780px,94vw)] flex-col overflow-hidden bt-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseLeave={() => preview(null)}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Palette size={16} className="text-accent-text" />
          <div className="flex-1 text-[15px] font-semibold text-text-1">Aparência geral</div>
          <button type="button" className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}

function GlassTune({ settings, conn }: { settings: SettingsEvent | null; conn: Connection }) {
  const current = applyGlassPatch(
    { glass: settings?.ui_theme?.glass || 55, glass_alpha: settings?.ui_theme?.glass_alpha || 70 },
    {},
  );
  const power = current.glass;
  const alpha = current.glass_alpha;
  const save = (patch: { glass?: number; glass_alpha?: number }) => {
    const next = applyGlassPatch(current, patch);
    const body = patch.glass !== undefined ? { glass: next.glass } : { glass_alpha: next.glass_alpha };
    conn.api<SettingsEvent>("/api/settings/ui", body).then((s) => conn.setSettings(s)).catch(() => {});
  };
  return (
    <SettingsPanel className="flex items-center gap-3">
      <div className="min-w-0 flex-1 space-y-2">
        <label className="block text-[12px] text-text-2">
          Potência do efeito
          <input type="range" min={15} max={100} value={power} className="mt-1 w-full" onInput={(e) => save({ glass: Number(e.currentTarget.value) })} />
        </label>
        <label className="block text-[12px] text-text-2">
          Transparência
          <input type="range" min={15} max={100} value={alpha} className="mt-1 w-full" onInput={(e) => save({ glass_alpha: Number(e.currentTarget.value) })} />
        </label>
      </div>
      <span className="relative h-16 w-24 shrink-0 overflow-hidden rounded-xl">
        <span className="absolute inset-0 bg-[linear-gradient(135deg,#7eb6ff,#c96442_50%,#10a37f)]" />
        <span className="bt-glass-sample absolute inset-2 flex items-center justify-center rounded-lg text-[11px] font-medium text-white">Aa</span>
      </span>
    </SettingsPanel>
  );
}

function VibrancySample({ on }: { on: boolean }) {
  return (
    <span className="relative h-9 w-12 shrink-0 overflow-hidden rounded-md border border-border">
      <span className="absolute inset-0 bg-[linear-gradient(135deg,#7eb6ff,#c96442_55%,#10a37f)]" />
      <span className={cn("absolute inset-y-1 left-0.5 w-4 rounded", on ? "bg-white/25 backdrop-blur" : "bg-[#2b2b2b]")} />
      <span className="absolute inset-y-1 right-0.5 left-5 rounded bg-[#1e1e1e]" />
    </span>
  );
}

function ModeCard(p: {
  icon: ReactNode;
  title: string;
  sub?: string;
  active: boolean;
  disabled?: boolean;
  onEnter: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("bt-settings-choice", p.active && "bt-settings-choice--on", p.disabled && "opacity-45")}
      onMouseEnter={() => !p.disabled && p.onEnter()}
      onClick={() => !p.disabled && p.onClick()}
      aria-pressed={p.active}
      aria-disabled={p.disabled || undefined}
      disabled={p.disabled}
      title={p.disabled ? p.sub : undefined}
    >
      <span className="bt-settings-choice__icon flex items-center gap-1.5">
        {p.icon}
        {p.active && <Check size={13} className="text-accent-text" />}
      </span>
      <span className="bt-settings-choice__title">{p.title}</span>
      {p.sub && <span className="bt-settings-choice__sub">{p.sub}</span>}
    </button>
  );
}
