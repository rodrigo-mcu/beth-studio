import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLastSeen, OFFLINE_RETRY_MS, parseLastSeen } from "../src/phone/offline.ts";

test("parseLastSeen: lê last_seen do 503 do proxy", () => {
  const d = parseLastSeen({ offline: true, last_seen: "2026-10-18T14:39:10Z" });
  assert.equal(d?.toISOString(), "2026-10-18T14:39:10.000Z");
});

test("parseLastSeen: sem hora, lixo e não-objeto viram null", () => {
  assert.equal(parseLastSeen({ offline: true }), null);
  assert.equal(parseLastSeen({ last_seen: "ontem" }), null);
  assert.equal(parseLastSeen({ last_seen: 123 }), null);
  assert.equal(parseLastSeen(null), null);
  assert.equal(parseLastSeen("x"), null);
});

test("formatLastSeen: às HH:MM de dd/mm (fuso do aparelho)", () => {
  const d = new Date(2026, 9, 7, 8, 5); // 7 out 2026 08:05 local
  assert.equal(formatLastSeen(d), "Visto pela última vez às 08:05 de 07/10");
  assert.equal(formatLastSeen(new Date(2026, 11, 31, 23, 59)), "Visto pela última vez às 23:59 de 31/12");
  assert.equal(formatLastSeen(null), null);
});

test("nova tentativa automática é curta", () => {
  assert.ok(OFFLINE_RETRY_MS >= 5000 && OFFLINE_RETRY_MS <= 30000);
});
