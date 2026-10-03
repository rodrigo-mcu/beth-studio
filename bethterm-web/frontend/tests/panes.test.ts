import { test } from "node:test";
import assert from "node:assert/strict";
import { isShellExeTitle, paneLabel } from "../src/lib/panes.ts";
import type { PaneInfo } from "../src/lib/types.ts";

const pane = (extra: Partial<PaneInfo>): PaneInfo =>
  ({
    pane_id: 1,
    window_id: 1,
    tab_id: 1,
    workspace: "default",
    size: { rows: 24, cols: 80 },
    title: "",
    cwd: "",
    cursor_x: 0,
    cursor_y: 0,
    tab_title: "",
    window_title: "",
    is_active: true,
    is_zoomed: false,
    ...extra,
  }) as PaneInfo;

test("caminho do powershell.exe nao e' o nome do terminal", () => {
  const title = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.equal(isShellExeTitle(title), true);
  assert.equal(
    paneLabel(pane({ title, kind: "powershell", kind_label: "PowerShell 5.1" })),
    "PowerShell 5.1",
  );
});

test("titulo de verdade e snyk-win.exe continuam", () => {
  assert.equal(isShellExeTitle("snyk-win.exe"), false);
  assert.equal(paneLabel(pane({ title: "snyk-win.exe", kind: "powershell" })), "snyk-win.exe");
  assert.equal(paneLabel(pane({ title: "Windows PowerShell", kind: "powershell", kind_label: "PowerShell 5.1" })), "Windows PowerShell");
  assert.equal(paneLabel(pane({ title: "✳ MY APP", kind: "wsl" })), "✳ MY APP");
});
