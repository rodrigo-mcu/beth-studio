import { test } from "node:test";
import assert from "node:assert/strict";
import { crumbs, joinPath, newFileNameError, rootLabel, withTextExt, wslFromUNC } from "../src/lib/folderBrowser.ts";
import { cwdFromPickedFolder } from "../src/lib/agents.ts";

// "\\" em string normal = uma barra invertida
const UBUNTU = "\\\\wsl.localhost\\Ubuntu\\";
const C = "C:\\";

test("joinPath", () => {
  assert.equal(joinPath(C, "a"), "C:\\a");
  assert.equal(joinPath("C:\\x", "a.md"), "C:\\x\\a.md");
  assert.equal(joinPath(UBUNTU, "home"), "\\\\wsl.localhost\\Ubuntu\\home");
});

test("wslFromUNC", () => {
  assert.deepEqual(wslFromUNC("\\\\wsl.localhost\\Ubuntu\\home\\eu"), { distro: "Ubuntu", path: "/home/eu" });
  assert.deepEqual(wslFromUNC("\\\\wsl$\\Debian\\"), { distro: "Debian", path: "/" });
  assert.equal(wslFromUNC("C:\\x"), null);
});

test("rootLabel", () => {
  assert.equal(rootLabel(C), "Disco C:");
  assert.equal(rootLabel(UBUNTU), "Ubuntu (Linux)");
});

test("crumbs", () => {
  assert.deepEqual(crumbs("C:\\Users\\eu"), [
    { label: "C:", path: C },
    { label: "Users", path: "C:\\Users" },
    { label: "eu", path: "C:\\Users\\eu" },
  ]);
  assert.deepEqual(crumbs("\\\\wsl.localhost\\Ubuntu\\home"), [
    { label: "Ubuntu", path: UBUNTU },
    { label: "home", path: "\\\\wsl.localhost\\Ubuntu\\home" },
  ]);
});

test("newFileNameError / withTextExt", () => {
  assert.equal(newFileNameError("notas.md"), "");
  assert.notEqual(newFileNameError(""), "");
  assert.notEqual(newFileNameError("a?b.txt"), "");
  assert.notEqual(newFileNameError("CON.txt"), "");
  assert.notEqual(newFileNameError("x.exe"), "");
  assert.notEqual(newFileNameError("fim.txt."), "");
  assert.equal(withTextExt("notas", ".md"), "notas.md");
  assert.equal(withTextExt("log.txt", ".md"), "log.txt");
});

test("cwdFromPickedFolder: pasta do Linux vira caminho do shell WSL", () => {
  assert.equal(cwdFromPickedFolder("\\\\wsl.localhost\\Ubuntu\\home\\eu\\proj", "wsl:ubuntu"), "/home/eu/proj");
  assert.equal(cwdFromPickedFolder("\\\\wsl.localhost\\Ubuntu\\home\\eu", "powershell"), "\\\\wsl.localhost\\Ubuntu\\home\\eu");
});
