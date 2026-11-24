export type AgentTool = "grok" | "cursor" | "claude" | "codex" | "gemini";

export const TOOL_LABEL: Record<AgentTool, string> = {
  grok: "Grok",
  cursor: "Cursor",
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

/** O nome que a aba e a lista mostram. A string fica neste arquivo para
 *  o pacote compilado guardar a palavra: o minificador apagava o rótulo. */
export const CODEX_NAME = "Codex";
export const GROK_NAME = "Grok";
export const CURSOR_NAME = "Cursor";
export const CLAUDE_NAME = "Claude";
export const GEMINI_NAME = "Gemini";

export function displayName(tool: AgentTool): string {
  if (tool === "codex") return CODEX_NAME;
  if (tool === "grok") return GROK_NAME;
  if (tool === "cursor") return CURSOR_NAME;
  if (tool === "claude") return CLAUDE_NAME;
  return GEMINI_NAME;
}

export function isAgentTool(v: string | undefined): v is AgentTool {
  return v === "grok" || v === "cursor" || v === "claude" || v === "codex" || v === "gemini";
}

/** A ferramenta no texto. A palavra tem que ser inteira: "codex" vale, "codextra" não. */
export function toolInText(text: string | undefined): AgentTool | undefined {
  const s = (text ?? "").toLowerCase();
  for (const tool of ["gemini", "grok", "codex", "claude", "cursor"] as const) {
    const re = new RegExp(`(^|[^a-z0-9])${tool}([^a-z0-9]|$)`);
    if (re.test(s)) return tool;
  }
  return undefined;
}

export interface PaneIdentityInput {
  title?: string;
  kind_label?: string;
  tool?: string;
  /** Texto da tela, quando o título do shell não diz a ferramenta. */
  screen?: string;
  /** Ferramenta gravada na aba, para o ícone continuar com a aba fechada. */
  stored?: string;
}

export interface PaneIdentity {
  name: string;
  tool?: AgentTool;
}

/**
 * Nome e ícone de um terminal. A aba e a lista da barra lateral usam esta
 * função, então os dois lugares mostram a mesma coisa. Uma ferramenta
 * reconhecida vence o título do shell: um Codex cujo título é "brian"
 * aparece como "Codex".
 */
export function paneIdentity(p: PaneIdentityInput, fallback: string): PaneIdentity {
  const titleTool = toolInText(p.title);
  const explicitTitle = titleTool && /^(cursor(?: agent)?|grok|codex|claude(?: code)?|gemini)(?:\s|$)/i.test(p.title?.trim() ?? "")
    ? titleTool : undefined;
  const tool =
    explicitTitle ??
    (isAgentTool(p.tool) ? p.tool : undefined) ??
    (/^\s*Cursor Agent\b/im.test(p.screen ?? "") ? "cursor" : undefined) ??
    (isAgentTool(p.stored) ? p.stored : undefined) ??
    toolInText(p.screen) ??
    titleTool ??
    toolInText(p.kind_label);
  if (tool) return { name: displayName(tool), tool };
  const title = p.title?.trim();
  if (title) return { name: title };
  return { name: fallback };
}
