import { test } from "node:test";
import assert from "node:assert/strict";
import { filesFromTransfer, imageFromItems, MAX_PASTE_BYTES, planUpload, uploadURL } from "../src/lib/pasteMedia.ts";

test("imagem conhecida vai para paste-image; resto vira copia (paste-file)", () => {
  assert.deepEqual(planUpload({ type: "image/PNG", name: "a.png", size: 10 }), {
    endpoint: "/api/paste-image",
    contentType: "image/png",
    name: "a.png",
  });
  const svg = planUpload({ type: "image/svg+xml", name: "x.svg", size: 10 });
  assert.equal("endpoint" in svg && svg.endpoint, "/api/paste-file");
  const pdf = planUpload({ type: "application/pdf", name: "relatório.pdf", size: 10 });
  assert.equal("endpoint" in pdf && pdf.contentType, "application/octet-stream");
  assert.ok("error" in planUpload({ type: "image/png", name: "big.png", size: MAX_PASTE_BYTES + 1 }));
  assert.ok("error" in planUpload({ type: "image/png", name: "vazio.png", size: 0 }));
});

test("colar traz pdf, video e imagem, nao so' a foto", () => {
  const pdf = { name: "a.pdf" } as unknown as File;
  const video = { name: "a.mp4" } as unknown as File;
  const png = { name: "a.png" } as unknown as File;
  const items = [
    { kind: "string", type: "text/plain", getAsFile: () => null },
    { kind: "file", type: "application/pdf", getAsFile: () => pdf },
    { kind: "file", type: "video/mp4", getAsFile: () => video },
    { kind: "file", type: "image/png", getAsFile: () => png },
  ];
  assert.deepEqual(filesFromTransfer({ items }), [pdf, video, png]);
  assert.deepEqual(filesFromTransfer({ items: [], files: [pdf] as unknown as FileList }), [pdf]);
});

test("acha a imagem entre os itens colados", () => {
  const f = { name: "clip.png" } as unknown as File;
  const items = [
    { kind: "string", type: "text/plain", getAsFile: () => null },
    { kind: "file", type: "image/png", getAsFile: () => f },
  ];
  assert.equal(imageFromItems(items), f);
  assert.equal(imageFromItems([{ kind: "string", type: "text/html", getAsFile: () => null }]), null);
});

test("URL do envio", () => {
  assert.equal(uploadURL({ endpoint: "/api/paste-image", contentType: "image/png", name: "a b.png" }, 28), "/api/paste-image?pane_id=28");
  assert.equal(
    uploadURL({ endpoint: "/api/paste-file", contentType: "application/octet-stream", name: "a b.pdf" }, 3),
    "/api/paste-file?pane_id=3&name=a+b.pdf",
  );
});
