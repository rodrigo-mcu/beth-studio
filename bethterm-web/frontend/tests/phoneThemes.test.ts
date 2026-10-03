import { test } from "node:test";
import assert from "node:assert/strict";
import { EXTRA_THEMES, findTheme, themeVars } from "../src/phone/themes.ts";
import { contrast } from "../src/lib/uiTheme.ts";

// Cada par que aparece na tela, com o mínimo WCAG para o uso.
const PAIRS: [fg: string, bg: string, min: number][] = [
  ["ink", "bg", 7],
  ["ink", "surface", 7],
  ["ink", "surface2", 4.5],
  ["termInk", "termBg", 7],
  ["muted", "bg", 4.5],
  ["muted", "surface", 4.5],
  ["faint", "surface", 3],
  ["brandInk", "brand", 4.5],
  ["brand", "surface", 3],
  ["brand", "bg", 3],
  ["wait", "surface", 3],
  ["ok", "surface", 3],
  ["rec", "surface", 3],
];

for (const t of EXTRA_THEMES) {
  test(`contraste: ${t.label}`, () => {
    const c = t.colors as unknown as Record<string, string>;
    for (const [fg, bg, min] of PAIRS) {
      const r = contrast(c[fg], c[bg]);
      assert.ok(r >= min, `${t.id}: ${fg} sobre ${bg} = ${r.toFixed(2)} (mínimo ${min})`);
    }
    // ícone branco no botão de gravar
    assert.ok(contrast("#ffffff", t.colors.rec) >= 3, `${t.id}: branco sobre rec`);
  });
}

test("ids únicos e sem colidir com auto/light/dark", () => {
  const ids = EXTRA_THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["auto", "light", "dark"]) assert.equal(findTheme(id), undefined);
});

test("themeVars cobre as variáveis do phone.css", () => {
  const v = themeVars(EXTRA_THEMES[0].colors);
  for (const k of ["--bg", "--surface-2", "--brand-ink", "--wait-soft", "--rec-soft", "--term-bg", "--term-ink", "--focus"]) {
    assert.ok(v[k], k);
  }
  assert.match(v["--wait-soft"], /^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
});
