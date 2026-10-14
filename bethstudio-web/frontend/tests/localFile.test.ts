// Deteccao/resolucao de caminho de arquivo local (por tipo de pane).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distroFromWslUnc,
  paneIsWsl,
  isPosixAbsolutePath,
  isUncPath,
  isWindowsAbsolutePath,
  localFileKind,
  resolveLinkPath,
  stripFileScheme,
  wslUncPath,
} from "../src/lib/localFile.ts";

test("localFileKind: por extensão, sem distinguir maiúsculas", () => {
  assert.equal(localFileKind("relatorio.md"), "text");
  assert.equal(localFileKind("RELATORIO.TXT"), "text");
  assert.equal(localFileKind("app.log"), "text");
  assert.equal(localFileKind("foto.PNG"), "image");
  assert.equal(localFileKind("img.jpeg"), "image");
  assert.equal(localFileKind("icone.svg"), "image");
  assert.equal(localFileKind("app.exe"), null);
  assert.equal(localFileKind("semextensao"), null);
});

test("classificação de forma do caminho", () => {
  assert.ok(isWindowsAbsolutePath("C:\\src\\x.md"));
  assert.ok(isWindowsAbsolutePath("C:/src/x.md"));
  assert.ok(!isWindowsAbsolutePath("src/x.md"));
  assert.ok(isUncPath("\\\\server\\share\\x.md"));
  assert.ok(isUncPath("\\\\wsl$\\Debian\\home\\x.md"));
  assert.ok(!isUncPath("C:\\x.md"));
  assert.ok(isPosixAbsolutePath("/home/user/x.md"));
  assert.ok(!isPosixAbsolutePath("//server/share")); // isso e' estilo UNC, nao POSIX
  assert.ok(!isPosixAbsolutePath("relatorio.md"));
});

test("wslUncPath monta \\\\wsl.localhost\\<distro>\\... (o Go tenta \\\\wsl$ se falhar)", () => {
  assert.equal(wslUncPath("Debian", "/home/user/relatorio.md"), "\\\\wsl.localhost\\Debian\\home\\user\\relatorio.md");
  assert.equal(wslUncPath("Ubuntu", "/mnt/data/x/y.png"), "\\\\wsl.localhost\\Ubuntu\\mnt\\data\\x\\y.png");
});

test("stripFileScheme: tira o file://host, decodifica", () => {
  assert.equal(stripFileScheme("file:///C:/src/x.md"), "/C:/src/x.md");
  assert.equal(stripFileScheme("file://pc/C:/src/x.md"), "/C:/src/x.md");
  assert.equal(stripFileScheme("file://pc/home/user/x%20y.md"), "/home/user/x y.md");
  assert.equal(stripFileScheme("/já/é/caminho.md"), "/já/é/caminho.md");
});

test("resolveLinkPath: absoluto do Windows, direto", () => {
  assert.equal(resolveLinkPath("C:\\src\\repo\\README.md", {}), "C:\\src\\repo\\README.md");
  assert.equal(resolveLinkPath("C:/src/repo/README.md", {}), "C:\\src\\repo\\README.md");
  assert.equal(resolveLinkPath("\\\\server\\share\\foto.png", {}), "\\\\server\\share\\foto.png");
});

test("resolveLinkPath: file:// para caminho do Windows (mesmo vindo de um pane WSL)", () => {
  assert.equal(resolveLinkPath("file:///C:/tmp/bethstudio/clipboard-images/x.png", { paneKind: "wsl", paneDistro: "Debian" }), "C:\\tmp\\bethstudio\\clipboard-images\\x.png");
  assert.equal(resolveLinkPath("/mnt/c/tmp/x.png", { paneKind: "wsl", paneDistro: "Debian" }), "C:\\tmp\\x.png");
});

test("resolveLinkPath: POSIX absoluto só resolve em pane WSL", () => {
  assert.equal(resolveLinkPath("/home/user/repo/relatorio.md", { paneKind: "wsl", paneDistro: "Debian" }), "\\\\wsl.localhost\\Debian\\home\\user\\repo\\relatorio.md");
  // distro desconhecida: não inventa um nome ("default" não existe no \\wsl$)
  assert.equal(resolveLinkPath("/home/user/repo/relatorio.md", { paneKind: "wsl" }), null);
  assert.equal(resolveLinkPath("/home/user/repo/relatorio.md", { paneKind: "powershell" }), null);
  assert.equal(resolveLinkPath("/home/user/repo/relatorio.md", {}), null);
});

test("resolveLinkPath: relativo, resolvido contra o cwd do pane", () => {
  // Windows
  assert.equal(
    resolveLinkPath("relatorio.md", { paneKind: "powershell", paneCwd: "file:///C:/dados/repo/app/" }),
    "C:\\dados\\repo\\app\\relatorio.md",
  );
  assert.equal(
    resolveLinkPath("lab/nuvem-cameras/pedidos-parceria.md", { paneKind: "powershell", paneCwd: "file:///C:/dados/repo/projeto-video/" }),
    "C:\\dados\\repo\\projeto-video\\lab\\nuvem-cameras\\pedidos-parceria.md",
  );
  // WSL
  assert.equal(
    resolveLinkPath("lab/dir/notes.md", { paneKind: "wsl", paneDistro: "Debian", paneCwd: "file://pc/mnt/data/repo/proj" }),
    "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\proj\\lab\\dir\\notes.md",
  );
});

test("WSL: /mnt/<letra>/ é unidade do Windows; /mnt/<nome>/ e o resto ficam no WSL", () => {
  const ctx = { paneKind: "wsl", paneDistro: "Debian" };
  assert.equal(resolveLinkPath("/mnt/d/docs/notes.md", ctx), "D:\\docs\\notes.md");
  assert.equal(resolveLinkPath("/mnt/data/repo/proj/notes.md", ctx), "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\proj\\notes.md");
  assert.equal(resolveLinkPath("/home/user/notes.md", ctx), "\\\\wsl.localhost\\Debian\\home\\user\\notes.md");
});

test("WSL: pane de agente (kind other) com cwd Linux ou marcado pelo Go conta como WSL", () => {
  // marcado pelo Go (panekind.go: wsl + wsl_distro)
  assert.equal(
    resolveLinkPath("/mnt/data/repo/proj/notes.md", { paneKind: "other", paneWsl: true, paneDistro: "Debian" }),
    "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\proj\\notes.md",
  );
  // sem marca, mas cwd UNC do WSL (dá a distro também)
  assert.ok(paneIsWsl({ paneKind: "other", paneCwd: "file://wsl.localhost/Debian/home/u" }));
  assert.equal(
    resolveLinkPath("/home/u/notes.md", { paneKind: "other", paneCwd: "file://wsl.localhost/Debian/home/u" }),
    "\\\\wsl.localhost\\Debian\\home\\u\\notes.md",
  );
  // cwd Linux sem distro conhecida: é WSL, mas não dá para montar o caminho
  assert.ok(paneIsWsl({ paneKind: "other", paneCwd: "file://pc/mnt/data/repo" }));
  assert.equal(resolveLinkPath("/mnt/data/repo/notes.md", { paneKind: "other", paneCwd: "file://pc/mnt/data/repo" }), null);
  // Windows / ssh / git bash: não
  assert.ok(!paneIsWsl({ paneKind: "other", paneCwd: "file:///C:/src" }));
  assert.ok(!paneIsWsl({ paneKind: "ssh", paneCwd: "file://remoto/home/u" }));
  assert.ok(!paneIsWsl({ paneKind: "gitbash", paneCwd: "file://pc/c/Users/u" }));
});

test("file:// do WSL: host ignorado, %XX decodificado, wsl.localhost vira UNC", () => {
  const ctx = { paneKind: "wsl", paneWsl: true, paneDistro: "Debian" };
  assert.equal(resolveLinkPath("file:///mnt/data/repo/proj/notes.md", ctx), "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\proj\\notes.md");
  assert.equal(resolveLinkPath("file://meu-pc/mnt/data/repo/proj/notes.md", ctx), "\\\\wsl.localhost\\Debian\\mnt\\data\\repo\\proj\\notes.md");
  assert.equal(resolveLinkPath("file://localhost/mnt/data/minhas%20notas.md", ctx), "\\\\wsl.localhost\\Debian\\mnt\\data\\minhas notas.md");
  assert.equal(resolveLinkPath("file://wsl.localhost/Ubuntu/home/u/notes.md", ctx), "\\\\wsl.localhost\\Ubuntu\\home\\u\\notes.md");
  assert.equal(distroFromWslUnc("\\\\wsl$\\Arch\\x"), "Arch");
  // esquema que não é arquivo nunca vira caminho relativo
  assert.equal(resolveLinkPath("vscode://file/x.md", { paneKind: "powershell", paneCwd: "file:///C:/src" }), null);
});

test("resolveLinkPath: til não é colado no cwd como se fosse relativo", () => {
  const ctx = { paneKind: "powershell", paneCwd: "file:///D:/docs/" };
  assert.equal(resolveLinkPath("~\\docs\\manual.pdf", ctx), "~\\docs\\manual.pdf");
  assert.equal(resolveLinkPath("~/docs/manual.pdf", ctx), "~\\docs\\manual.pdf");
  assert.equal(resolveLinkPath("~", ctx), "~");
});

test("resolveLinkPath: ambíguo (sem cwd claro, ou pane sem cwd) não vira clicável", () => {
  assert.equal(resolveLinkPath("relatorio.md", { paneKind: "powershell" }), null);
  assert.equal(resolveLinkPath("relatorio.md", { paneKind: "wsl", paneCwd: "" }), null);
  assert.equal(resolveLinkPath("relatorio.md", { paneKind: "ssh" }), null); // cwd remoto, nada resolvivel localmente
  assert.equal(resolveLinkPath("", { paneKind: "powershell", paneCwd: "file:///C:/x" }), null);
});
