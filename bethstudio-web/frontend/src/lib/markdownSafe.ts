// Renderização de Markdown para o painel de preview de arquivo local:
// biblioteca leve (marked, MIT, sem dependências), sem executar script e
// sem carregar recurso remoto. Defesa em profundidade além do CSP do app
// (que já bloqueia script inline e imagem remota): HTML bruto embutido no
// Markdown nunca passa (vira texto escapado), e qualquer <script>/<iframe>/
// atributo on___= que sobrar é removido do HTML final antes de inserir.
//
// Links e imagens:
//   - http(s) (inclusive URL solta, autolink do GFM) vira <a href>: o clique
//     passa pelo caminho único de lib/links.ts (/api/open-link, navegador
//     padrão);
//   - caminho local (relativo à pasta do .md, ou absoluto) de texto/imagem
//     vira <a data-local-href> (o painel abre ali mesmo) ou <img> servida
//     por /api/local-file (mesma validação do Go);
//   - imagem remota NUNCA carrega sozinha (privacidade/rastreamento): vira
//     um marcador com a URL, que abre no navegador ao clicar.
import { Marked, type Tokens } from "marked";
import { isHttpUrl } from "./links.ts";
import { localFileKind, localFileURL } from "./localFile.ts";
import { resolveDocLink } from "./filePreview.ts";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Remove qualquer <script>/<iframe> e atributo "on___=" que ainda sobre, e neutraliza "javascript:"/"data:" em href/src. */
function stripDangerous(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*(javascript:|data:text\/html)/gi, '$1=$2about:blank');
}

export interface MarkdownOpts {
  /** caminho absoluto do .md (resolve links/imagens relativos à pasta dele) */
  filePath?: string;
}

function makeMarked(opts: MarkdownOpts): Marked {
  const local = (href: string) => (opts.filePath ? resolveDocLink(href, opts.filePath) : null);
  return new Marked({
    gfm: true,
    renderer: {
      // HTML bruto dentro do .md (ex. <script>, <img onerror=...>) nunca é
      // interpretado como HTML: sai como texto visível, escapado.
      html(token: { text: string }) {
        return escapeHtml(token.text);
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const href = token.href ?? "";
        if (/^https?:\/\//i.test(href) && isHttpUrl(href)) {
          return `<a href="${escapeHtml(href)}" title="${escapeHtml(href)}">${inner}</a>`;
        }
        const path = local(href);
        if (path && localFileKind(path)) {
          return `<a data-local-href="${escapeHtml(path)}" title="${escapeHtml(path)}">${inner}</a>`;
        }
        return `<span class="md-link-off" title="${escapeHtml(href)}">${inner}</span>`;
      },
      image(token: Tokens.Image) {
        const href = token.href ?? "";
        const alt = escapeHtml(token.text ?? "");
        if (/^https?:\/\//i.test(href)) {
          return `<span class="md-remote-img" data-href="${escapeHtml(href)}" title="Imagem remota não carregada (privacidade). Clique para abrir no navegador.">&#128444; ${alt ? `${alt} — ` : ""}${escapeHtml(href)}</span>`;
        }
        const path = local(href);
        if (path && localFileKind(path) === "image") {
          // <img>, nunca SVG embutido: nenhum script de SVG roda
          return `<img src="${escapeHtml(localFileURL(path))}" alt="${alt}" title="${escapeHtml(path)}" loading="lazy">`;
        }
        return `<span class="md-img-missing">${alt || escapeHtml(href)}</span>`;
      },
    },
  });
}

/** Markdown -> HTML seguro para dangerouslySetInnerHTML (painel de preview). */
export function renderMarkdownSafe(md: string, opts: MarkdownOpts = {}): string {
  const html = makeMarked(opts).parse(md, { async: false }) as string;
  return stripDangerous(html);
}
