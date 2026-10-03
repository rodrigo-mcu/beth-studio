# 0091 — Native Win32 BethTerm installer / updater (embedded zstd)

## What

A new crate `bethterm-setup` produces a **native Win32** installer /
updater (CreateWindowEx + common controls v6). No WebView, no HTML UI.

`build.rs` writes `BethTerm.pkg.zst` (zstd tar, level 19). The pack script
appends that blob plus a trailer (`u64` size + `BTZSTPKG`) onto the GUI stub
so **each setup is a single self-contained exe**.

On run:

1. Native window with path (default `%PUBLIC%\BethTerm`, typically `C:\Users\Public\BethTerm`; see patch 0092).
2. Procurar (SHBrowseForFolder), progress bar, shortcut checkbox.
3. Button is **Instalar** or **Atualizar** if `bethterm-gui.exe` is already there.
4. Refuses `\app\tools\wezterminator`.

## Pack

From the repo root, after a release GUI build:

```
pack-bethterm-setup.cmd
```

Output: `dist\BethTerm-Setup.exe` only.

## Revert

Remove the `bethterm-setup` workspace member and crate.
