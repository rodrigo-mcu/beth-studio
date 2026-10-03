# 0196 — Tray menu: Beth Studio first, native window in one submenu

**Status:** Implemented 2026-10-03.

## What

The tray menu mixed Beth Studio items with items that only concern the
native terminal window, and nothing said which ones applied. With the
native window off, **Painel**, **Janela nova como** and **Desenho** were
still there (one greyed, two clickable and useless), and the on/off
switch was hidden in the middle of the list under a name that looked
like a list ("Janelas de terminal nativas").

New layout:

```
Beth Studio                      (bold, default item)
Novo terminal ▸
Sistema (CPU, memória, disco)
────────
Janela nativa ▸
    ☑ Usar a janela nativa (desmarcado: só o Beth Studio)
    ────────
    Painel                       (greyed when the native window is off)
    Novas janelas como ▸         (greyed when off)  Abas (clássico) / Painel
    Desenho (vale na próxima abertura) ▸   (greyed when off)  GPU / CPU
    ────────
    Esconder tudo / Mostrar todas   (only when windows exist)
    Reiniciar a janela nativa (terminais continuam)
────────
(one row per native window, only when there are any)
────────
Sair da bandeja (terminais continuam)
Encerrar tudo (fecha os terminais)       (only when the host runs)
```

| Before | After |
|---|---|
| Janelas de terminal nativas | Usar a janela nativa (desmarcado: só o Beth Studio) |
| Reiniciar janelas nativas (terminais continuam) | Reiniciar a janela nativa (terminais continuam) |
| Janela nova como | Novas janelas como |
| Desenho | Desenho (vale na próxima abertura) |
| Abrir todas | Mostrar todas |
| Sistema | Sistema (CPU, memória, disco) |
| Fechar janelas (terminais continuam) | Sair da bandeja (terminais continuam) |
| Encerrar BethTerm (fecha os terminais) | Encerrar tudo (fecha os terminais) |

Behavior of every action is unchanged (same command ids, same
handlers). Only the grouping, the texts, the greying and the bold default
item changed. `menu_entries` now returns the top-level rows and the new
`native_menu_entries` returns the submenu rows; `append_entry` builds
either one.

## Files

- `wtinator/src/tray.rs`
- `wtinator/src/context_menu.rs` (hint text)
- `wtinator/src/gui_restart.rs` (doc comment)

## Revert

Restore the old `menu_entries`, drop `native_menu_entries`,
`append_entry`, `MenuCtx` and `TrayMenuEntry::NativeMenu`, put the old
strings back, remove the `enabled` argument of the two submenu helpers
and the `SetMenuDefaultItem` call. Remove row 0196 and this file.
