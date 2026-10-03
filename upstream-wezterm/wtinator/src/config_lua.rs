// wtinator::config_lua — Phase 0 stub.
//
// Full implementation: Phase 1.A (W1.A.2 / W1.A.3).
// Reads the `wtinator = { ... }` table from the active Lua config and
// stores it in a global WtinatorConfig.

use anyhow::Result;

/// Initialize the config subsystem. Called from [`crate::install`].
pub fn initialize() -> Result<()> {
    // Phase 0: nothing to do yet. The real implementation will:
    // 1. Look up the `wtinator` key in the loaded Lua config.
    // 2. Deserialize it into a WtinatorConfig via serde.
    // 3. Validate the schema (unknown keys → warning, not error).
    // 4. Store it in a once_cell::sync::OnceCell for fast read access.
    Ok(())
}
