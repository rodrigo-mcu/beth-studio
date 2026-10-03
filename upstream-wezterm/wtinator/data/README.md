# Bundled Gogh theme catalog

`gogh-themes.json` is a snapshot of
<https://github.com/Gogh-Co/Gogh> `data/themes.json`.

BethTerm ships this file inside the Settings app so themes work
offline. “Update themes” tries the network first (optional
`BETHTERM_THEMES_URL`, then jsDelivr / Gogh), and falls back to this
snapshot.

Refresh the snapshot (from `upstream-wezterm/`):

```
curl.exe -fsSL -o wtinator/data/gogh-themes.json https://cdn.jsdelivr.net/gh/Gogh-Co/Gogh@master/data/themes.json
```

To serve your own mirror later, publish the same JSON and set:

```
BETHTERM_THEMES_URL=https://raw.githubusercontent.com/<you>/bethterm-themes/main/themes.json
```
