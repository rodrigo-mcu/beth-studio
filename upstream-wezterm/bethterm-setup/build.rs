//! Build the installer stub and, when `BETHTERM_DIST` has the release
//! binaries, write `BethTerm.pkg.zst` next to them. `pack-bethterm-setup`
//! then appends that zstd blob onto `BethTerm-Setup.exe` so each setup is
//! a single self-contained executable.

use std::env;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=BETHTERM_DIST");
    println!("cargo:rerun-if-changed=build.rs");
    embed_win32_resources();

    let dist = env::var_os("BETHTERM_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
                .join("..")
                .join("target")
                .join("release")
        });
    println!("cargo:rerun-if-changed={}", dist.display());
    write_build_stamp(&dist);

    let pkg = dist.join("BethTerm.pkg.zst");
    match pack_dist(&dist, &pkg) {
        Ok(n) => println!(
            "cargo:warning=bethterm-setup wrote {} file(s) → {}",
            n,
            pkg.display()
        ),
        Err(e) => println!("cargo:warning=bethterm-setup skip pack ({e})"),
    }
}

fn write_build_stamp(dist: &Path) {
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("build_stamp.txt");
    let mut newest = None;
    for name in ["bethterm-gui.exe", "bethterm-host.exe", "bethterm.exe"] {
        let path = dist.join(name);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if newest.map(|n| modified > n).unwrap_or(true) {
            newest = Some(modified);
        }
    }
    let secs = newest
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(out, secs.to_string());
}

fn pack_dist(dist: &Path, dest: &Path) -> anyhow::Result<usize> {
    for name in ["bethterm.exe", "bethterm-gui.exe", "bethterm-host.exe"] {
        anyhow::ensure!(
            dist.join(name).is_file(),
            "missing {} in {}",
            name,
            dist.display()
        );
    }

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for rel in [
        "bethterm.exe",
        "bethterm-gui.exe",
        "bethterm-host.exe",
        "bethterm-web.exe",
        "bethterm-tool.exe",
        "wtinator-config.exe",
        "OpenConsole.exe",
        "conpty.dll",
        "libEGL.dll",
        "libGLESv2.dll",
        "mesa/opengl32.dll",
    ] {
        let src = dist.join(rel);
        if src.is_file() {
            files.push((rel.replace('\\', "/"), src));
        }
    }

    let repo = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("..")
        .join("..");
    for name in ["LICENSE.md", "NOTICE.md"] {
        let src = repo.join(name);
        if src.is_file() {
            files.push((name.to_string(), src));
        }
    }
    anyhow::ensure!(!files.is_empty(), "no files to pack");

    let file = File::create(dest)?;
    let mut encoder = zstd::Encoder::new(BufWriter::new(file), 19)?;
    {
        let mut tar = tar::Builder::new(&mut encoder);
        tar.follow_symlinks(false);
        for (rel, src) in &files {
            tar.append_path_with_name(src, rel)?;
            println!("cargo:rerun-if-changed={}", src.display());
        }
        tar.finish()?;
    }
    encoder.finish()?;
    Ok(files.len())
}

fn embed_win32_resources() {
    #[cfg(not(windows))]
    {
        return;
    }

    #[cfg(windows)]
    {
    let windows_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("..")
        .join("assets")
        .join("windows");
    let manifest = windows_dir.join("manifest.manifest");
    let icon = windows_dir.join("terminal.ico");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rerun-if-changed={}", icon.display());

    let rcfile_name = Path::new(&env::var_os("OUT_DIR").unwrap()).join("resource.rc");
    let mut rcfile = std::fs::File::create(&rcfile_name).unwrap();
    let win = windows_dir.display().to_string().replace('\\', "\\\\");
    write!(
        rcfile,
        r#"
#include <winres.h>
#define IDI_ICON 0x101
1 RT_MANIFEST "{win}\\manifest.manifest"
IDI_ICON ICON "{win}\\terminal.ico"
VS_VERSION_INFO VERSIONINFO
FILEVERSION     1,0,0,0
PRODUCTVERSION  1,0,0,0
FILEFLAGSMASK   VS_FFI_FILEFLAGSMASK
FILEFLAGS       0
FILEOS          VOS__WINDOWS32
FILETYPE        VFT_APP
FILESUBTYPE     VFT2_UNKNOWN
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904E4"
        BEGIN
            VALUE "CompanyName",      "BethTerm contributors\0"
            VALUE "FileDescription",  "BethTerm installer / updater\0"
            VALUE "FileVersion",      "0.1.0\0"
            VALUE "LegalCopyright",   "Wez Furlong and BethTerm contributors, MIT licensed\0"
            VALUE "InternalName",     "bethterm-setup\0"
            VALUE "OriginalFilename", "BethTerm-Setup.exe\0"
            VALUE "ProductName",      "BethTerm\0"
            VALUE "ProductVersion",   "0.1.0\0"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1252
    END
END
"#,
        win = win,
    )
    .unwrap();
    drop(rcfile);

    if let Ok(target) = env::var("TARGET") {
        if let Some(tool) = cc::windows_registry::find_tool(target.as_str(), "cl.exe") {
            for (key, value) in tool.env() {
                env::set_var(key, value);
            }
        }
    }
    embed_resource::compile(rcfile_name);
    }
}
