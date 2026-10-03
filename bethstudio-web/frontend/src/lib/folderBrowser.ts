// Navegador de pastas dentro da página (components/FolderBrowser.tsx), sobre
// POST /api/local-fs/list. Funções puras, testadas em tests/folderBrowser.test.ts.

/** Junta pasta + nome com "\" (caminhos do Windows e \\wsl.localhost\...). */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return /[\\/]$/.test(dir) ? dir + name : `${dir}\\${name}`;
}

/** "\\wsl.localhost\Ubuntu\home\eu" -> { distro: "Ubuntu", path: "/home/eu" }. */
export function wslFromUNC(p: string): { distro: string; path: string } | null {
  const m = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(\\.*)?$/i.exec(p.trim());
  if (!m) return null;
  const rest = (m[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return { distro: m[1], path: rest || "/" };
}

/** Nome curto de uma raiz para a coluna de atalhos. */
export function rootLabel(root: string): string {
  const w = wslFromUNC(root);
  if (w) return `${w.distro} (Linux)`;
  const d = /^([A-Za-z]):\\?$/.exec(root);
  if (d) return `Disco ${d[1].toUpperCase()}:`;
  return root;
}

/** Pedaços do caminho para a trilha clicável (cada um leva ao seu caminho). */
export function crumbs(p: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  const w = /^(\\\\[^\\]+\\[^\\]+)(\\.*)?$/.exec(p); // UNC: \\servidor\compartilhamento
  let head: string;
  let rest: string;
  if (w) {
    head = w[1] + "\\";
    rest = w[2] ?? "";
    const wsl = wslFromUNC(p);
    out.push({ label: wsl ? wsl.distro : w[1], path: head });
  } else {
    const d = /^([A-Za-z]:)(\\.*)?$/.exec(p);
    if (!d) return [{ label: p, path: p }];
    head = d[1] + "\\";
    rest = d[2] ?? "";
    out.push({ label: d[1], path: head });
  }
  let acc = head;
  for (const part of rest.split("\\").filter(Boolean)) {
    acc = acc.endsWith("\\") ? acc + part : `${acc}\\${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

export const NEW_FILE_EXTS = [".md", ".txt"] as const;
const TEXT_EXT = [".md", ".markdown", ".txt", ".log"];

/** Mesma regra do Go (validNewFileName): "" = ok, senão a mensagem. */
export function newFileNameError(name: string): string {
  if (!name.trim()) return "Digite um nome";
  if (name.length > 200) return "Nome grande demais";
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return 'O nome não pode ter \\ / : * ? " < > |';
  if (/^\s|[.\s]$/.test(name)) return "O nome não pode começar com espaço nem terminar em ponto ou espaço";
  const base = name.replace(/\.[^.]*$/, "").toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) return "Esse nome é reservado pelo Windows";
  if (!TEXT_EXT.some((e) => name.toLowerCase().endsWith(e))) return "O nome precisa terminar em .md, .txt ou .log";
  return "";
}

/** Põe a extensão escolhida se o nome não terminar em uma de texto. */
export function withTextExt(name: string, ext: string): string {
  const n = name.trim();
  if (!n) return n;
  return TEXT_EXT.some((e) => n.toLowerCase().endsWith(e)) ? n : n + ext;
}

/** Arquivo que o painel de arquivo abre (texto ou imagem). */
export function openableFile(name: string): boolean {
  return /\.(md|markdown|txt|log|png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}

/** Caminho do texto "Sem título" do painel de arquivo (ainda não está no disco). */
export const UNTITLED_PATH = "untitled:";

const SCRATCH_KEY = "bethstudio.scratch.last";

/** Último texto "Sem título" fechado sem salvar (para "Recuperar"). */
export function loadScratch(): { text: string; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SCRATCH_KEY) ?? "null") as { text?: unknown; at?: unknown } | null;
    if (v && typeof v.text === "string" && v.text.trim() && typeof v.at === "number") return { text: v.text, at: v.at };
  } catch {
    /* sem storage */
  }
  return null;
}

export function saveScratch(text: string | null) {
  try {
    if (text && text.trim()) localStorage.setItem(SCRATCH_KEY, JSON.stringify({ text, at: Date.now() }));
    else localStorage.removeItem(SCRATCH_KEY);
  } catch {
    /* sem storage */
  }
}
