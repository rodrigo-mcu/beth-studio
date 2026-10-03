// bethterm — Phase 0 binary entry point (directory name is historical).
//
// **Status (Phase 0):** placeholder. This file exists so the workspace
// has a binary member, but it does **not** yet drive the GUI. The real
// implementation is described in `docs/ARCHITECTURE.md §"Option B"`:
// we copy `upstream-wezterm/wezterm/src/main.rs` into this file,
// change the binary name, and add `wtinator::install()` calls before
// the GUI starts.
//
// Until that copy is in place, this binary just prints a banner and
// exits — useful for verifying that the workspace links.

use anyhow::Result;

fn main() -> Result<()> {
    eprintln!("BethTerm v0.1.0 (placeholder binary)");
    eprintln!();
    eprintln!("This is a stub binary. The real entry point is being wired up in");
    eprintln!("Phase 0 / W0.4 of docs/IMPLEMENTATION.md.");
    eprintln!();
    eprintln!("For now, run the upstream wezterm to use the underlying emulator:");
    eprintln!("    cargo run -p wezterm --release  (inside upstream-wezterm/)");
    eprintln!();

    // Initialize the delta crate so we can confirm it links. This is a
    // no-op in Phase 0.
    wtinator::install()?;

    eprintln!("wtinator::install() returned Ok — the delta crate links correctly.");
    eprintln!();
    eprintln!("Exiting (stub).");
    Ok(())
}
