import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addRow,
  buildApply,
  buildDeletes,
  deleteBlocker,
  changeCount,
  duplicateRow,
  editedValue,
  emptyChanges,
  revertRow,
  setCell,
  toggleDelete,
} from "../src/lib/dbChanges.ts";
import type { DbCell } from "../src/lib/dbApi.ts";

const cols = [
  { name: "id", type: "INTEGER" },
  { name: "nome", type: "TEXT" },
  { name: "cidade", type: "TEXT" },
];

test("editar, apagar, inserir e montar o envio", () => {
  const rows: DbCell[][] = [
    [1, "Ana", "Recife"],
    [2, "Bia", null],
    [3, "Caio", "Natal"],
  ];
  let ch = emptyChanges();
  ch = setCell(ch, rows[0], "nome", "Ana Maria", rows[0][1]);
  ch = setCell(ch, rows[0], "id", "100", rows[0][0]); // mudar a chave: o WHERE usa a original
  ch = toggleDelete(ch, rows[1]);
  const added = addRow(ch, 3);
  ch = setCell(added.changes, added.row, "nome", "Davi");
  assert.equal(changeCount(ch), 3);
  assert.deepEqual(buildApply(ch, rows, cols, ["id"]), {
    deletes: [{ where: { id: 2 } }],
    updates: [{ where: { id: 1 }, set: { nome: "Ana Maria", id: "100" } }],
    inserts: [{ values: { nome: "Davi" } }],
  });
});

test("voltar ao valor de antes não conta como alteração", () => {
  const row: DbCell[] = [1, "Ana", null];
  let ch = setCell(emptyChanges(), row, "nome", "X", "Ana");
  ch = setCell(ch, row, "nome", "Ana", "Ana");
  assert.equal(changeCount(ch), 0);
  ch = setCell(ch, row, "cidade", null, null);
  assert.equal(changeCount(ch), 0);
  assert.equal(editedValue(ch, row, "nome"), undefined);
});

test("apagar linha nova a remove; desfazer linha original volta tudo", () => {
  const row: DbCell[] = [1, "Ana", "Recife"];
  const a = addRow(emptyChanges(), 3);
  let ch = toggleDelete(a.changes, a.row);
  assert.equal(ch.added.length, 0);
  ch = setCell(ch, row, "nome", "B", "Ana");
  ch = toggleDelete(ch, row);
  assert.equal(changeCount(ch), 1); // apagada (a edição não conta junto)
  ch = revertRow(ch, row);
  assert.equal(changeCount(ch), 0);
});

test("duplicar copia os valores (com o que foi digitado), menos a chave", () => {
  const row: DbCell[] = [1, "Ana", "Recife"];
  let ch = setCell(emptyChanges(), row, "cidade", "Olinda", "Recife");
  const d = duplicateRow(ch, row, cols, new Set(["id"]));
  ch = d.changes;
  assert.deepEqual(buildApply(ch, [row], cols, ["id"]).inserts, [{ values: { nome: "Ana", cidade: "Olinda" } }]);
});

test("sem a chave no resultado não monta UPDATE às cegas", () => {
  const row: DbCell[] = ["Ana"];
  const ch = toggleDelete(emptyChanges(), row);
  assert.throws(() => buildApply(ch, [row], [{ name: "nome" }], ["id"]), /chave primária/);
});

test("apagar várias linhas pela chave", () => {
  const rows: DbCell[][] = [
    [16498, "A", "x"],
    [16497, "B", null],
  ];
  assert.deepEqual(buildDeletes(rows, cols, ["id"]), [{ where: { id: 16498 } }, { where: { id: 16497 } }]);
});

test("apagar recusa sem chave, chave fora do resultado ou chave nula", () => {
  assert.throws(() => buildDeletes([[1, "A", "x"]], cols, []), /sem chave/);
  assert.throws(() => buildDeletes([[1, "A", "x"]], [{ name: "nome", type: "TEXT" }], ["id"]), /não está no resultado/);
  assert.throws(() => buildDeletes([[null, "A", "x"]], cols, ["id"]), /vazia/);
});

test("deleteBlocker explica por que não dá para apagar", () => {
  assert.match(deleteBlocker(undefined, cols), /chave primária/);
  assert.match(deleteBlocker([], cols), /chave primária/);
  assert.match(deleteBlocker(["codigo"], cols), /Inclua a coluna da chave \(codigo\)/);
  assert.equal(deleteBlocker(["id"], cols), "");
});
