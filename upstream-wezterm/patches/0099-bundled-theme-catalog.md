# 0099 — Bundled Gogh theme catalog

## What

Ship `wtinator/data/gogh-themes.json` (Gogh snapshot) inside the
binary. Settings unpacks it into `%APPDATA%\bethterm\themes` on first
open, so the grid works offline.

“Update themes” tries `BETHTERM_THEMES_URL` (your GitHub mirror, when
you have one), then jsDelivr / Gogh, then the bundled snapshot.

Refresh the snapshot:

```
curl.exe -fsSL -o wtinator/data/gogh-themes.json https://cdn.jsdelivr.net/gh/Gogh-Co/Gogh@master/data/themes.json
```

## Files

- `wtinator/data/gogh-themes.json`, `wtinator/data/README.md`
- `wtinator/src/theme_download.rs`, `notify.rs`, `notify_ipc.rs`
- `wtinator-config/src/main.rs`, frontend

## Revert

Remove the JSON snapshot and restore network-only `download_catalog()`.
