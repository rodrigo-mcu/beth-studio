// Configuração do comando de inicialização do WSL, por distro (Configurações >
// Terminais > WSL). O Studio o digita num terminal visível quando falta a pasta
// de um terminal na restauração (wsl_init_cfg.go, restore_init.go). Testado em
// tests/wslInit.test.ts.

import type { Connection } from "./connection";

export interface WslInitCfg {
  enabled: boolean;
  command: string;
  timeout_sec: number;
  /** "Abrir na pasta padrão"; vazio = a home do WSL */
  default_dir?: string;
}

export interface WslInitState {
  /** as distros instaladas */
  distros: string[];
  /** chave = nome da distro em minúsculas */
  config: Record<string, WslInitCfg>;
}

export const WSL_INIT_DEFAULT_TIMEOUT = 300;
export const WSL_INIT_MIN_TIMEOUT = 10;
export const WSL_INIT_MAX_TIMEOUT = 1800;
export const WSL_INIT_MAX_COMMAND = 1024;

const hasControl = (s: string) => [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** As mesmas regras do Studio; devolve a mensagem para o usuário, ou null se está bom. */
export function validateWslInit(c: WslInitCfg): string | null {
  const command = c.command.trim();
  if (hasControl(command)) return "O comando não pode ter quebra de linha nem caracteres de controle.";
  if ([...command].length > WSL_INIT_MAX_COMMAND) return `O comando passa de ${WSL_INIT_MAX_COMMAND} caracteres.`;
  if (c.enabled && command === "") return "Informe o comando de inicialização.";
  if (!Number.isInteger(c.timeout_sec) || c.timeout_sec < WSL_INIT_MIN_TIMEOUT || c.timeout_sec > WSL_INIT_MAX_TIMEOUT)
    return `O tempo máximo fica entre ${WSL_INIT_MIN_TIMEOUT} e ${WSL_INIT_MAX_TIMEOUT} segundos.`;
  const dir = (c.default_dir ?? "").trim();
  if (dir !== "" && (!dir.startsWith("/") || hasControl(dir))) return "A pasta padrão deve ser um caminho Linux absoluto (começa com /).";
  return null;
}

/** A configuração da distro (sem distinguir maiúsculas), ou o padrão desligado. */
export function cfgFor(state: WslInitState, distro: string): WslInitCfg {
  return state.config[distro.toLowerCase()] ?? { enabled: false, command: "", timeout_sec: WSL_INIT_DEFAULT_TIMEOUT };
}

export function loadWslInit(conn: Connection): Promise<WslInitState> {
  return conn.api<WslInitState>("/api/wsl-init");
}

export function saveWslInit(conn: Connection, distro: string, config: WslInitCfg): Promise<WslInitState> {
  return conn.api<WslInitState>("/api/wsl-init", { distro, config });
}

/** "Testar agora": abre o terminal de inicialização da distro e digita o comando, sem restaurar nada. */
export function testWslInit(conn: Connection, distro: string): Promise<unknown> {
  return conn.api("/api/wsl-init/test", { distro });
}
