import { test } from "node:test";
import assert from "node:assert/strict";
import { changeAbsPath, changeCounts, folderKey, folderSep, joinFolder, paneFolder, pruneTabSidebar, setTabSidebarOpen, splitRel, tabSidebarOpen } from "../src/lib/worktree.ts";

test("a sidebar de uma guia não abre a da outra", () => {
  let open = {};
  assert.equal(tabSidebarOpen(open, "a"), false);
  open = setTabSidebarOpen(open, "a", true);
  assert.equal(tabSidebarOpen(open, "a"), true);
  assert.equal(tabSidebarOpen(open, "b"), false);
  open = setTabSidebarOpen(open, "b", true);
  open = setTabSidebarOpen(open, "a", false);
  assert.equal(tabSidebarOpen(open, "a"), false);
  assert.equal(tabSidebarOpen(open, "b"), true);
});

test("pruneTabSidebar esquece guia fechada e mantém a aberta", () => {
  const open = pruneTabSidebar({ a: true, b: false, c: true }, ["a", "b"]);
  assert.deepEqual(open, { a: true, b: false });
  assert.equal(pruneTabSidebar(open, ["a", "b"]), open);
});

test("folderKey não diferencia maiúsculas no Windows", () => {
  assert.equal(folderKey("C:\\Repo\\Beth"), folderKey("c:\\repo\\beth\\"));
  assert.notEqual(folderKey("/home/eu/Repo"), folderKey("/home/eu/repo"));
});

test("changeAbsPath fica dentro da pasta da guia", () => {
  assert.equal(changeAbsPath("C:\\repo", "src/a.go"), "C:\\repo\\src\\a.go");
  assert.equal(changeAbsPath("C:\\repo\\", "../segredo"), null);
  assert.equal(changeAbsPath("C:\\repo", ""), null);
  assert.equal(changeAbsPath("/Users/brian/repo", "src/a.ts"), "/Users/brian/repo/src/a.ts");
  assert.equal(folderSep("/Users/brian"), "/");
  assert.equal(joinFolder("/Users/brian", "msa-dev"), "/Users/brian/msa-dev");
  assert.equal(joinFolder("C:\\repo", "src"), "C:\\repo\\src");
});

test("paneFolder no Mac usa o caminho POSIX do terminal", () => {
  assert.equal(paneFolder("file://localhost/Users/brian", {}, true), "/Users/brian");
  assert.equal(paneFolder("/Users/brian/repo", {}, true), "/Users/brian/repo");
  assert.equal(paneFolder("file://localhost/Users/brian", {}, false), "");
  assert.equal(paneFolder("file:///C:/src", { paneKind: "powershell" }, false), "C:\\src");
});

test("splitRel e changeCounts", () => {
  assert.deepEqual(splitRel("src/lib/a.ts"), { dir: "src/lib", name: "a.ts" });
  assert.deepEqual(splitRel("README.md"), { dir: "", name: "README.md" });
  assert.deepEqual(
    changeCounts([
      { path: "a", status: "novo" },
      { path: "b", status: "alterado" },
      { path: "c", status: "alterado" },
    ]),
    [
      { status: "alterado", n: 2 },
      { status: "novo", n: 1 },
    ],
  );
});
