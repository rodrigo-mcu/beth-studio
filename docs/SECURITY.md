# Security

## Reporting a vulnerability

**Please do not file a public issue.**

Use GitHub's **privately reported vulnerabilities** on this repository (Security → Advisories → Report a vulnerability). If the repository is not yet on GitHub, contact the maintainers privately.

Include:

- A description of the vulnerability.
- Steps to reproduce.
- The version affected.
- Your assessment of the impact.
- (Optional) a suggested fix.

We aim to acknowledge within **3 business days**.

## What we promise

- We will not pursue legal action against researchers who act in good faith.
- We will keep you informed of the fix timeline.
- We will credit you in the release notes unless you ask to remain anonymous.
- For critical vulnerabilities, we will cut a point release as soon as a fix is ready.

## What we don't promise

- We do not run a paid bug bounty program.
- We do not commit to specific SLAs for non-critical issues.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest tagged release | Yes |
| Development `main` | Best effort |
| Older tags | No, unless a critical issue is still widely used |

## Scope

**In scope:**

- The `wtinator` crate, `wtinator-config`, and the `bethterm` placeholder binary.
- BethTerm session restore, native menus, per-pane config, and the Settings app IPC.
- The configuration Lua surface we add.

**Out of scope** (file upstream):

- Unmodified WezTerm behavior in `upstream-wezterm/`. See https://github.com/wezterm/wezterm.
- The build toolchain (Rust, Cargo, Visual Studio Build Tools, etc.).

## Threat model

BethTerm is a local application.

- A local attacker with the same user account can read the config and run the binary. We cannot defend against that.
- We do not add network attack surface beyond what WezTerm already exposes, except the opt-in theme download and the local named pipe used by the Settings app.
- Clipboard handling is local. We do not sync the clipboard to any other device.

We do **not** protect against:

- Compromised dependencies in the build toolchain.
- A user pasting attacker-controlled text into a shell.
- A user being tricked into running a hostile `wezterm.lua`.

## History

- 2026-06-06 — Page created.
- 2026-09-05 — Rebranded to BethTerm; reporting path is GitHub private advisories.
