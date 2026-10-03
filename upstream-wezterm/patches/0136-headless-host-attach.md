# 0136 — No "Connecting…" ghost window when attaching the host

**Status:** Implemented 2026-09-21.

## Symptom

Every GUI start logged the config pipe server starting twice and wrote
the session snapshot twice every 30 s. `window_heal` warned about an
HWND with a 0x0 client area that "is still not a usable on-screen
window". A frontend trace showed `Creating TermWindow for
mux_window_id=0` **before** the host attach, and the host's windows
then got local windows 1 and 2.

## Cause

`ClientDomain::attach(None)` (called for the auto-connect host domain)
builds an upstream `ConnectionUI`, which opens a mux window with a
termwiz pane to show "wezterm: Connecting…". When the attach finishes
the UI closes that window. In BethTerm the window X hides to the
notification area (patches 0105/0106), so the window never died: it
lived on hidden, zero-sized, with its own `TermWindow`, 30 s session
timer and pipe server.

## Fix (`wezterm-client/src/domain.rs`)

When the domain is the BethTerm host (`BETHTERM_HOST_DOMAIN_NAME`,
mirrors `wtinator::host::DOMAIN_NAME`) and no window was passed in,
`attach` uses `ConnectionUI::new_headless()`. The host is a local Unix
socket and attaches in well under a second; no progress window is
needed. Other client domains (ssh, tls, user unix domains) keep the
upstream UI.

## Verification

Trace run (`WEZTERM_LOG=bethterm_gui::frontend=trace`): exactly one
`Creating TermWindow` per host window, one pipe server start, and no
`window_heal` warning.

## Revert

Restore the unconditional `ConnectionUI::with_params` and remove the
constant. Remove row 0136 from `PATCHES.md` and this document.
