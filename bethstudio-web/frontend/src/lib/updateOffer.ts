// O que a aba Sobre mostra depois de GET /api/update/check.
// A comparação de versão fica no Studio; aqui só decidimos os botões.

export interface UpdateCheck {
  current: string;
  latest?: string;
  update: boolean;
  can_install: boolean;
  ui_available: boolean;
  ui_already: boolean;
  setup_available: boolean;
  message: string;
  html_url?: string;
  api_level?: number;
}

const RELEASE_PREFIX = "https://github.com/rodrigo-mcu/beth-studio/releases/tag/";

/** Só a página do release oficial. Qualquer outro endereço não vira link. */
export function safeReleaseURL(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith(RELEASE_PREFIX)) return null;
  const rest = raw.slice(RELEASE_PREFIX.length);
  if (rest === "" || !/^[0-9A-Za-z.+-]+$/.test(rest)) return null;
  return raw;
}

export interface UpdateButtons {
  showUI: boolean;
  showSetup: boolean;
}

/** allowInstall é falso no modo somente leitura e no Studio aberto pelo navegador. */
export function updateButtons(c: UpdateCheck, allowInstall: boolean): UpdateButtons {
  const can = Boolean(c.update && allowInstall && c.can_install);
  return {
    showUI: can && c.ui_available && !c.ui_already,
    showSetup: can && c.setup_available,
  };
}
