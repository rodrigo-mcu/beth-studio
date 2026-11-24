// Regras das configurações de aparência no Mac. Funções puras: o botão e
// os sliders têm de concordar com estes números, senão o clique não grava
// e o liquid glass some quando a API devolve o tema sem o campo.

export const GLASS_MIN = 15;
export const GLASS_MAX = 100;
export const GLASS_POWER_DEFAULT = 55;
export const GLASS_ALPHA_DEFAULT = 70;

/** Próximo estado do vibrancy a partir do valor mostrado. Ausente não é desligado. */
export function nextVibrancy(shown: boolean): boolean {
  return !shown;
}

/**
 * O que a amostra e a classe CSS devem mostrar.
 * Com as configurações já carregadas, um campo ausente é desligado: o JSON
 * antigo omitia false, e tratar isso como “ainda não chegou” religava o
 * material pelo localStorage. Antes de carregar, só o clique pendente liga.
 */
export function shownVibrancy(
  saved: boolean | null | undefined,
  pending: boolean | null,
  settingsLoaded = false,
): boolean {
  if (typeof saved === "boolean") return saved;
  if (settingsLoaded) return false;
  return pending === true;
}

/**
 * O que o shell mostra depois que /api/settings chegou. O "1" do
 * localStorage só vale antes da resposta. Com as configurações carregadas
 * ele não entra no pending — senão um false omitido religa o material.
 */
export function shellVibrancyOn(
  uiTheme: { vibrancy?: boolean | null } | null | undefined,
  settingsLoaded: boolean,
  localStorageOn: boolean,
): boolean {
  const pending = settingsLoaded ? null : localStorageOn;
  return shownVibrancy(uiTheme?.vibrancy, pending, settingsLoaded);
}

/** O que o botão posta. O componente usa esta função, não um toggle solto. */
export function vibrancyClick(shown: boolean): { next: boolean; storage: "0" | "1" } {
  const next = nextVibrancy(shown);
  return { next, storage: next ? "1" : "0" };
}

/**
 * Depois que a resposta chega o pending é limpo. O formato é o JSON real
 * de ui_theme: se vibrancy foi omitido, o campo não existe. O "1" que o
 * clique anterior deixou no localStorage não pode religar.
 */
export function vibrancyShownAfterSave(
  response: { vibrancy?: boolean | null } | null | undefined,
  localStorageStillOn: boolean,
): boolean {
  return shellVibrancyOn(response, true, localStorageStillOn);
}

/** Clique mais a resposta real de /api/settings/ui. */
export interface VibrancyClickResult {
  posted: boolean;
  pendingCleared: boolean;
  localStorage: "0" | "1";
  shown: boolean;
}

/**
 * O caminho do botão: o próximo estado é postado, o localStorage acompanha,
 * e o que a amostra mostra depois da resposta é o valor gravado. Se a
 * resposta omitir false (snapshot antigo), com as configurações carregadas
 * a amostra fica desligada — não volta pelo localStorage "1".
 */
export function applyVibrancyClick(
  shown: boolean,
  response: { vibrancy?: boolean | null },
): VibrancyClickResult {
  const click = vibrancyClick(shown);
  return {
    posted: click.next,
    pendingCleared: true,
    localStorage: click.storage,
    shown: vibrancyShownAfterSave(response, click.storage === "1"),
  };
}

export interface GlassTune {
  glass: number;
  glass_alpha: number;
}

/** Limita potência e transparência à faixa do slider. */
export function clampGlass(value: number): number {
  if (!Number.isFinite(value)) return GLASS_MIN;
  return Math.min(GLASS_MAX, Math.max(GLASS_MIN, Math.round(value)));
}

/**
 * Um slider grava só o seu campo. O outro permanece. Valor fora da faixa
 * entra no limite, não é recusado em silêncio.
 */
export function applyGlassPatch(current: GlassTune, patch: Partial<GlassTune>): GlassTune {
  const next = { ...current };
  if (patch.glass !== undefined) next.glass = clampGlass(patch.glass);
  if (patch.glass_alpha !== undefined) next.glass_alpha = clampGlass(patch.glass_alpha);
  return next;
}

/** Os sliders só aparecem com o vibrancy ligado. */
export function glassSlidersVisible(vibrancyOn: boolean): boolean {
  return vibrancyOn;
}
