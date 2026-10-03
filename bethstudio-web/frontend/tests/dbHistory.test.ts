import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightPieces, oneLine, searchTerms } from "../src/lib/dbHistory.ts";

test("termos: separa por espaço e ignora maiúsculas", () => {
  assert.deepEqual(searchTerms("  Maria   APARECIDA "), ["maria", "aparecida"]);
  assert.deepEqual(searchTerms("   "), []);
});

test("realce marca cada termo e os pedaços refazem o texto", () => {
  const text = "SELECT * FROM tblmidias WHERE nome ILIKE '%maria%'";
  const pieces = highlightPieces(text, ["maria", "from"]);
  assert.equal(pieces.map((p) => p.text).join(""), text);
  assert.deepEqual(pieces.filter((p) => p.hit).map((p) => p.text), ["FROM", "maria"]);
});

test("realce junta termos que se sobrepõem e aceita nenhum termo", () => {
  assert.deepEqual(highlightPieces("abcd", ["abc", "bcd"]), [{ text: "abcd", hit: true }]);
  assert.deepEqual(highlightPieces("abc", []), [{ text: "abc", hit: false }]);
  assert.deepEqual(highlightPieces("abc", ["x"]), [{ text: "abc", hit: false }]);
});

test("oneLine tira quebras e recuos", () => {
  assert.equal(oneLine("select a,\n\n   b\n from t"), "select a, b from t");
});
