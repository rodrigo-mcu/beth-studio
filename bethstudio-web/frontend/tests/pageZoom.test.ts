import { test } from "node:test";
import assert from "node:assert/strict";
import { isDefaultZoom, zoomLabel } from "../src/lib/pageZoom.ts";

test("isDefaultZoom: 100% com folga de ponto flutuante", () => {
  assert.equal(isDefaultZoom(1), true);
  assert.equal(isDefaultZoom(1.0001), true);
  assert.equal(isDefaultZoom(1.1), false);
  assert.equal(isDefaultZoom(0.9), false);
});

test("zoomLabel arredonda para porcentagem inteira", () => {
  assert.equal(zoomLabel(1.25), "125%");
  assert.equal(zoomLabel(0.8), "80%");
  assert.equal(zoomLabel(1.2000000001), "120%");
});
