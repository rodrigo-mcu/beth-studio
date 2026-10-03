import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAgent, cwdFromPickedFolder, explorerStart, Pending, requestIdFromError, shellKind, spawnCwd, waitingList, type AgentState } from "../src/lib/agents.ts";

test("agente aguardando: marcar, contar, manter o 'desde', limpar", () => {
  let s: AgentState = {};
  s = applyAgent(s, { ev: "agent", pane_id: 7, waiting: true, reason: "user_var", detail: "claude_status=waiting" }, 100);
  s = applyAgent(s, { ev: "agent", pane_id: 3, waiting: true, reason: "bell" }, 200);
  s = applyAgent(s, { ev: "agent", pane_id: 7, waiting: true, reason: "toast", detail: "Claude precisa de você" }, 300);
  const l = waitingList(s);
  assert.deepEqual(l.map((a) => a.pane), [7, 3]); // o mais antigo primeiro
  assert.equal(l[0].since, 100); // repetir o alerta nao zera o "desde"
  assert.equal(l[0].detail, "Claude precisa de você");
  // so' conta panes que existem no host
  assert.equal(waitingList(s, new Set([3])).length, 1);
  // digitar (reason input) e dispensar limpam
  s = applyAgent(s, { ev: "agent", pane_id: 7, waiting: false, reason: "input" });
  s = applyAgent(s, { ev: "agent", pane_id: 3, waiting: false, reason: "dismissed" });
  assert.equal(waitingList(s).length, 0);
  // limpar o que nao existe devolve o mesmo objeto
  assert.equal(applyAgent(s, { ev: "agent", pane_id: 99, waiting: false, reason: "input" }), s);
});

test("correlacao por request_id (spawned / erro / tempo esgotado)", async () => {
  const p = new Pending<{ pane_id: number }>();
  const a = p.add("r1", 1000);
  const b = p.add("r2", 1000);
  const c = p.add("r3", 30);
  assert.equal(p.resolve("r9", { pane_id: 1 }), false); // id desconhecido: ignora
  assert.equal(p.resolve("r1", { pane_id: 40 }), true);
  const id = requestIdFromError("spawn powershell (request r2): falhou ao criar");
  assert.equal(id, "r2");
  p.reject(id!, new Error("falhou"));
  assert.deepEqual(await a, { pane_id: 40 });
  await assert.rejects(b, /falhou/);
  await assert.rejects(c, /sem resposta/);
  assert.equal(p.size, 0);
  assert.equal(requestIdFromError("outro erro"), null);
});

test("tipo de shell pelo id", () => {
  assert.equal(shellKind("powershell"), "powershell");
  assert.equal(shellKind("pwsh"), "powershell");
  assert.equal(shellKind("cmd"), "cmd");
  assert.equal(shellKind("wsl.ubuntu"), "wsl");
  assert.equal(shellKind("gitbash"), "gitbash");
  assert.equal(shellKind("mobaxterm.local"), "ssh");
  assert.equal(shellKind("app.debug"), "log");
});

test("pasta inicial convertida para o shell", () => {
  const win = "file:///C:/src/repo/web-app/";
  const lin = "file://my-desktop/mnt/data/src/repo/api-server/";
  const home = "file://desktop/home/user/x";
  assert.equal(spawnCwd(win, "powershell"), "C:\\src\\repo\\web-app");
  assert.equal(spawnCwd(win, "wsl.ubuntu"), "/mnt/c/src/repo/web-app");
  assert.equal(spawnCwd(lin, "wsl.default"), "/mnt/data/src/repo/api-server");
  assert.equal(spawnCwd(home, "cmd"), ""); // caminho Linux sem equivalente no Windows
  assert.equal(spawnCwd("file://h/mnt/c/Users/x", "cmd"), "C:\\Users\\x");
  assert.equal(spawnCwd(win, "app.debug"), "");
  assert.equal(spawnCwd("", "cmd"), "");
});

test("seletor de pasta: abre no caminho Windows e devolve o formato do shell", () => {
  assert.equal(explorerStart(""), "");
  assert.equal(explorerStart("C:\\src\\repo"), "C:\\src\\repo");
  assert.equal(explorerStart("/mnt/c/src/repo"), "C:\\src\\repo");
  assert.equal(explorerStart("/home/user"), "");
  assert.equal(cwdFromPickedFolder("C:\\src\\repo", "powershell"), "C:\\src\\repo");
  assert.equal(cwdFromPickedFolder("C:\\src\\repo", "wsl.ubuntu"), "/mnt/c/src/repo");
  assert.equal(cwdFromPickedFolder("D:\\", "wsl.default"), "/mnt/d");
});
