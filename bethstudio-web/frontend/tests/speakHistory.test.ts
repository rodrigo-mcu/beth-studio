import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEAK_HISTORY_MAX, addEntry, isEntryList, preview, removeEntry, updateEntry, type SpeakEntry } from "../src/lib/speakHistory.ts";

const e = (id: string, text = `t${id}`): SpeakEntry => ({ id, at: 1, text, target: "term 1", sent: false });

test("addEntry: mais recente primeiro e limite", () => {
  let l: SpeakEntry[] = [];
  for (let i = 0; i < SPEAK_HISTORY_MAX + 5; i++) l = addEntry(l, e(String(i)));
  assert.equal(l.length, SPEAK_HISTORY_MAX);
  assert.equal(l[0].id, String(SPEAK_HISTORY_MAX + 4));
});

test("addEntry: texto vazio não entra e mesmo id não duplica", () => {
  assert.deepEqual(addEntry([], e("a", "  \n ")), []);
  const l = addEntry(addEntry([], e("a", "um")), e("a", "dois"));
  assert.equal(l.length, 1);
  assert.equal(l[0].text, "dois");
});

test("updateEntry e removeEntry", () => {
  const l = [e("a"), e("b")];
  assert.equal(updateEntry(l, "b", { sent: true })[1].sent, true);
  assert.equal(updateEntry(l, "b", { text: "novo" })[1].text, "novo");
  assert.deepEqual(removeEntry(l, "a").map((x) => x.id), ["b"]);
});

test("isEntryList rejeita lixo do localStorage", () => {
  assert.equal(isEntryList([e("a")]), true);
  assert.equal(isEntryList([{ id: 1 }]), false);
  assert.equal(isEntryList("x"), false);
});

test("preview: uma linha e corta com reticências", () => {
  assert.equal(preview("a\n\n b"), "a b");
  assert.equal(preview("x".repeat(200), 10), `${"x".repeat(9)}…`);
});
