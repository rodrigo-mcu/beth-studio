import { test } from "node:test";
import assert from "node:assert/strict";
import { noteWhen } from "../src/lib/notes.ts";

test("data da nota: dia/mês hora:minuto, com ano só se for outro ano", () => {
  const now = new Date(2026, 9, 2, 12, 0, 0);
  assert.equal(noteWhen(new Date(2026, 9, 2, 15, 4, 5).toISOString(), now), "02/10 15:04");
  assert.equal(noteWhen(new Date(2025, 11, 31, 9, 5, 0).toISOString(), now), "31/12/2025 09:05");
  assert.equal(noteWhen("lixo", now), "");
});
