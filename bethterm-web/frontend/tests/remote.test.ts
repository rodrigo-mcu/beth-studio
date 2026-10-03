import { test } from "node:test";
import assert from "node:assert/strict";
import { browserLabel, downloadName, isRemotePath, sinceLabel } from "../src/lib/remote.ts";

test("isRemotePath", () => {
  assert.equal(isRemotePath("/studio/"), true);
  assert.equal(isRemotePath("/studio"), true);
  assert.equal(isRemotePath("/studio/x"), true);
  assert.equal(isRemotePath("/"), false);
  assert.equal(isRemotePath("/studiox/"), false);
});

test("browserLabel", () => {
  assert.equal(
    browserLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0"),
    "Edge · Windows",
  );
  assert.equal(browserLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"), "Safari · Mac");
  assert.equal(browserLabel("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), "Firefox · Linux");
  assert.equal(browserLabel(""), "Navegador");
});

test("sinceLabel", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  assert.equal(sinceLabel("2026-09-30T11:59:40Z", now), "agora");
  assert.equal(sinceLabel("2026-09-30T11:55:00Z", now), "há 5 min");
  assert.equal(sinceLabel("2026-09-30T09:00:00Z", now), "há 3 h");
  assert.equal(sinceLabel("2026-09-28T12:00:00Z", now), "há 2 dias");
  assert.equal(sinceLabel("lixo", now), "");
});

test("downloadName", () => {
  assert.equal(downloadName('claude: C:\\x "y"', ".txt"), "claude C x y.txt");
  assert.equal(downloadName("", ".png"), "beth-studio.png");
});
