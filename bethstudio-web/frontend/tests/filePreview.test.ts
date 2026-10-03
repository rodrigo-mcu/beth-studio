// Painel de preview: o que "Copiar tudo" copia, links/imagens relativos
// dentro do .md, e a renderização (títulos, links, imagens) em sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { copyAllText, detectEol, editableText, fileBaseName, resolveDocLink, stepFont, stepZoom, toDiskText } from "../src/lib/filePreview.ts";
import { renderMarkdownSafe } from "../src/lib/markdownSafe.ts";

const MD = "# Pedidos de acesso\n\n## Fornecedor A\n\nVeja https://portal.example.com/x e [notas](notas.md).\n";

test("Copiar tudo: sempre o fonte cru, nunca o HTML renderizado", () => {
  const doc = { raw: MD };
  assert.equal(copyAllText(doc, "rendered"), MD);
  assert.equal(copyAllText(doc, "source"), MD);
  assert.ok(!copyAllText(doc, "rendered").includes("<h1>"));
});

test("resolveDocLink: relativo à pasta do .md (Windows e WSL), sem '..' no resultado", () => {
  const win = "C:\\dados\\repo\\proj\\docs\\notes.md";
  assert.equal(resolveDocLink("outro.md", win), "C:\\dados\\repo\\proj\\docs\\outro.md");
  assert.equal(resolveDocLink("./img/a.png", win), "C:\\dados\\repo\\proj\\docs\\img\\a.png");
  assert.equal(resolveDocLink("../README.md", win), "C:\\dados\\repo\\proj\\README.md");
  assert.equal(resolveDocLink("img/minha%20foto.png#x", win), "C:\\dados\\repo\\proj\\docs\\img\\minha foto.png");
  assert.equal(resolveDocLink("D:/outro/x.md", win), "D:\\outro\\x.md");

  const wsl = "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\proj\\lab\\notes.md";
  assert.equal(resolveDocLink("img/a.png", wsl), "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\proj\\lab\\img\\a.png");
  assert.equal(resolveDocLink("../../README.md", wsl), "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\README.md");
  assert.equal(resolveDocLink("/home/u/x.md", wsl), "\\\\wsl.localhost\\Debian\\home\\u\\x.md");
  assert.equal(resolveDocLink("/mnt/c/Users/u/x.png", wsl), "C:\\Users\\u\\x.png");
});

test("resolveDocLink: não é arquivo local -> null", () => {
  const win = "C:\\dados\\notes.md";
  assert.equal(resolveDocLink("https://example.com/x.md", win), null);
  assert.equal(resolveDocLink("#secao", win), null);
  assert.equal(resolveDocLink("mailto:a@example.com", win), null);
  assert.equal(resolveDocLink("javascript:alert(1)", win), null);
  assert.equal(resolveDocLink("../../../../x.md", win), null); // acima da raiz
  assert.equal(resolveDocLink("/abs/x.md", win), null); // "/..." num documento do Windows: ambíguo
});

test("fonte e zoom: limites e degraus", () => {
  assert.equal(stepFont(13, +1), 14);
  assert.equal(stepFont(9, -1), 9);
  assert.equal(stepFont(28, +1), 28);
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(1, -1), 0.75);
  assert.equal(stepZoom(0.6, 1), 0.75); // do "ajustar" (escala qualquer) para o próximo degrau
  assert.equal(fileBaseName("\\\\wsl.localhost\\Debian\\x\\notes.md"), "notes.md");
});

test("markdown: títulos viram h1/h2, URL solta vira link http, link relativo vira link local", () => {
  const html = renderMarkdownSafe(MD, { filePath: "C:\\dados\\docs\\pedidos.md" });
  assert.match(html, /<h1>Pedidos de acesso<\/h1>/);
  assert.match(html, /<h2>Fornecedor A<\/h2>/);
  assert.match(html, /<a href="https:\/\/portal\.example\.com\/x"/);
  assert.match(html, /<a data-local-href="C:\\dados\\docs\\notas\.md"/);
  assert.ok(!/href="notas\.md"/.test(html)); // nunca um href relativo (navegaria o app)
});

test("markdown: imagem local carrega por /api/local-file; imagem remota NÃO carrega (marcador clicável)", () => {
  const md = "![logo](img/logo.png)\n\n![rastreio](https://example.com/pixel.png)\n\n![vetor](img/a.svg)";
  const html = renderMarkdownSafe(md, { filePath: "\\\\wsl.localhost\\Debian\\mnt\\data\\notes.md" });
  const local = encodeURIComponent("\\\\wsl.localhost\\Debian\\mnt\\data\\img\\logo.png");
  assert.ok(html.includes(`<img src="/api/local-file?path=${local}"`), html);
  assert.ok(!/<img[^>]+src="https?:/.test(html)); // nada remoto em <img>
  assert.match(html, /class="md-remote-img" data-href="https:\/\/example\.com\/pixel\.png"/);
  // SVG só como <img> (scripts de SVG não rodam em <img>)
  assert.match(html, /<img src="\/api\/local-file\?path=[^"]+a\.svg"/);
  assert.ok(!/<svg/i.test(html));
});

test("markdown: sem caminho do arquivo, link/imagem relativos não viram nada clicável/carregável", () => {
  const html = renderMarkdownSafe("[x](notas.md) ![y](a.png)");
  assert.ok(!/data-local-href|<img/.test(html));
});

test("painel: ações pedidas estão ligadas (fonte do componente)", () => {
  const src = fs.readFileSync("src/components/FilePreviewPanel.tsx", "utf8");
  for (const route of ["/api/local-file/save-as", "/api/local-file/reveal", "/api/local-file/open-default"]) assert.ok(src.includes(route), route);
  assert.ok(src.includes("copyAllText({ raw: draft ?? doc.raw }, view)")); // o texto cru (o editado, se editando)
  assert.match(src, /selectAllChildren\(el\)/); // seleciona só o conteúdo do painel
  assert.match(src, /e\.key === "Escape"/);
  assert.match(src, /k === "a"/);
  assert.match(src, /k === "s"/);
  assert.match(src, /onContextMenu/);
  assert.match(src, /data-local-href/);
  assert.match(src, /md-remote-img/);
  // botões só com ícone (tooltip), sem rótulo de texto
  assert.ok(!/>\s*[A-Za-zÀ-ú][^<>{}]*<\/IconButton>/.test(src));
});

test("editor: textarea usa \n; ao salvar volta ao fim de linha do arquivo", () => {
  const crlf = "# T\r\n\r\nlinha\r\n";
  assert.equal(detectEol(crlf), "\r\n");
  assert.equal(detectEol("a\nb\n"), "\n");
  assert.equal(detectEol("sem quebra"), "\n");
  const ed = editableText(crlf);
  assert.equal(ed, "# T\n\nlinha\n");
  assert.equal(toDiskText(ed + "nova\n", "\r\n"), "# T\r\n\r\nlinha\r\nnova\r\n");
  assert.equal(toDiskText("a\nb", "\n"), "a\nb");
  // texto colado com \r\n dentro de um arquivo \n não vira \r\r\n
  assert.equal(toDiskText("a\r\nb", "\r\n"), "a\r\nb");
});

test("editor: painel tem modo editar, salvar no próprio arquivo e conflito", () => {
  const src = fs.readFileSync("src/components/FilePreviewPanel.tsx", "utf8");
  assert.match(src, /\/api\/local-file\/write/);
  assert.match(src, /X-File-Mtime/);
  assert.match(src, /<textarea/);
  const app = fs.readFileSync("src/App.tsx", "utf8");
  assert.match(app, /\/api\/local-file\/open-dialog/);
});
