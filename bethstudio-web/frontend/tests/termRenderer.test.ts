// Escolha do renderizador do terminal (WebGL x DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_GL_PANES, MODE_OPTIONS, chooseRenderer, isSoftwareGl, parseRendererPref } from "../src/lib/termRenderer.ts";

const gpu = { webgl2: true, renderer: "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" };
const soft = { webgl2: true, renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" };
const none = { webgl2: false, renderer: "" };

test("automatico: WebGL na GPU, DOM sem WebGL2 ou com WebGL por software", () => {
  assert.equal(chooseRenderer("auto", gpu, 0), "webgl");
  assert.equal(chooseRenderer("auto", none, 0), "dom");
  assert.equal(chooseRenderer("auto", soft, 0), "dom");
});

test("preferencia do usuario: dom sempre dom; webgl forca mesmo por software, mas nunca sem WebGL2", () => {
  assert.equal(chooseRenderer("dom", gpu, 0), "dom");
  assert.equal(chooseRenderer("webgl", soft, 0), "webgl");
  assert.equal(chooseRenderer("webgl", none, 0), "dom");
});

test("teto de terminais com WebGL: passou do limite, usa DOM", () => {
  assert.equal(chooseRenderer("auto", gpu, MAX_GL_PANES - 1), "webgl");
  assert.equal(chooseRenderer("auto", gpu, MAX_GL_PANES), "dom");
  assert.equal(chooseRenderer("webgl", gpu, MAX_GL_PANES), "dom");
});

test("isSoftwareGl reconhece renderizadores de CPU", () => {
  for (const s of ["SwiftShader", "llvmpipe (LLVM 15)", "Microsoft Basic Render Driver", "Software Rasterizer"]) assert.ok(isSoftwareGl(s), s);
  for (const s of ["Intel(R) UHD Graphics", "NVIDIA GeForce RTX 3060", "AMD Radeon", ""]) assert.ok(!isSoftwareGl(s), s);
});

test("preferencia invalida vira automatico", () => {
  assert.equal(parseRendererPref("webgl"), "webgl");
  assert.equal(parseRendererPref("dom"), "dom");
  for (const v of [null, undefined, "", "gpu", 3]) assert.equal(parseRendererPref(v), "auto");
});

test("contraste minimo continua ligado nos dois modos; so' o piscar sai no DOM", () => {
  assert.equal(MODE_OPTIONS.dom.minimumContrastRatio, 3);
  assert.equal(MODE_OPTIONS.webgl.minimumContrastRatio, 3);
  assert.equal(MODE_OPTIONS.dom.cursorBlink, false);
  assert.equal(MODE_OPTIONS.webgl.cursorBlink, true);
});
