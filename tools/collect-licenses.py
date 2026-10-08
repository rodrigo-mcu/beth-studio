#!/usr/bin/env python3
"""Copia os textos de licença das dependências que vão nos binários.

    python tools/collect-licenses.py <pasta-de-saída>

Gera <saida>/{go,npm,rust}/<nome>-<versão>/LICENSE* e um index.txt. Roda no
release (RELEASING.md); o resultado vai dentro do zip, na pasta licenses/.
Precisa de: go, cargo (nightly) e, para o npm, o frontend instalado (pnpm install).
Falha (código 1) se alguma dependência não tiver arquivo de licença, para o
release não sair sem os avisos que a MIT/BSD exigem.
"""
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIC = re.compile(r"^(licen[sc]e|copying|notice|unlicense)", re.I)
missing = []
index = []
TAB = chr(9)
NL = chr(10)


def safe(name):
    return re.sub(r"[^A-Za-z0-9._@-]+", "_", name)


def copy_licenses(kind, name, version, src_dir):
    dest = os.path.join(OUT, kind, safe(f"{name}-{version}"))
    found = False
    for f in sorted(os.listdir(src_dir)):
        p = os.path.join(src_dir, f)
        if os.path.isfile(p) and LIC.match(f):
            os.makedirs(dest, exist_ok=True)
            shutil.copyfile(p, os.path.join(dest, f))
            found = True
    index.append(f"{kind}\t{name}\t{version}\t{'ok' if found else 'SEM LICENÇA'}")
    if not found:
        missing.append(f"{kind}: {name} {version}")


def run(cmd, cwd, env=None):
    e = dict(os.environ)
    e.update(env or {})
    return subprocess.run(cmd, cwd=cwd, env=e, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout


def go():
    d = os.path.join(ROOT, "bethstudio-web")
    out = run(["go", "list", "-deps", "-f", "{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}", "."], d, {"GOOS": "windows"})
    seen = set()
    for line in out.splitlines():
        parts = (line.strip().split("|") + ["", "", ""])[:3]
        mod, ver, dr = parts
        if not dr or mod == "bethstudio-web" or mod in seen:
            continue
        seen.add(mod)
        copy_licenses("go", mod, ver, dr)


def npm():
    fe = os.path.join(ROOT, "bethstudio-web", "frontend")
    pkg = json.load(open(os.path.join(fe, "package.json"), encoding="utf-8"))
    store = os.path.join(fe, "node_modules", ".pnpm")
    todo = list(pkg.get("dependencies", {}))
    seen = set()

    def locate(name):
        # pnpm: .pnpm/<name>@<ver>/node_modules/<name>  (@scope/x vira @scope+x)
        key = name.replace("/", "+") + "@"
        for e in sorted(os.listdir(store)):
            if e.startswith(key):
                p = os.path.join(store, e, "node_modules", *name.split("/"))
                if os.path.isdir(p):
                    return p
        p = os.path.join(fe, "node_modules", *name.split("/"))
        return p if os.path.isdir(p) else None

    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        p = locate(name)
        if not p:
            missing.append(f"npm: {name} (não instalado: rode pnpm install)")
            continue
        meta = json.load(open(os.path.join(p, "package.json"), encoding="utf-8"))
        copy_licenses("npm", name, meta.get("version", "?"), p)
        todo.extend(meta.get("dependencies", {}))


def rust():
    d = os.path.join(ROOT, "upstream-wezterm")
    meta = json.loads(run(["cargo", "+nightly", "metadata", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"], d))
    pk = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    wanted = {"wezterm", "wezterm-mux-server", "bethstudio-setup"}
    st = [p["id"] for p in meta["packages"] if p["name"] in wanted]
    seen = set()
    while st:
        i = st.pop()
        if i in seen:
            continue
        seen.add(i)
        for dep in nodes[i]["deps"]:
            if any(k["kind"] in (None, "build") for k in dep["dep_kinds"]):
                st.append(dep["pkg"])
    ws = set(meta["workspace_members"])
    for i in sorted(seen):
        p = pk[i]
        if i in ws or p.get("source") is None:  # código do próprio WezTerm/nosso: coberto pelo LICENSE.md
            continue
        crate_dir = os.path.dirname(p["manifest_path"])
        copy_licenses("rust", p["name"], p["version"], crate_dir)
        # libssh-rs-sys embute o libssh (LGPL-2.1): os textos ficam em vendored/
        vend = os.path.join(crate_dir, "vendored")
        if os.path.isdir(vend):
            dest = os.path.join(OUT, "rust", safe(f"{p['name']}-{p['version']}"), "libssh")
            for f in ("COPYING", "BSD", "LICENSE"):
                if os.path.isfile(os.path.join(vend, f)):
                    os.makedirs(dest, exist_ok=True)
                    shutil.copyfile(os.path.join(vend, f), os.path.join(dest, f))
        # crates que não trazem arquivo de licença: registra o que o Cargo.toml declara
        key = TAB.join(["rust", p["name"], p["version"], "SEM LICENÇA"])
        if key in index and p.get("license"):
            index.remove(key)
            missing.remove(f"rust: {p['name']} {p['version']}")
            dest = os.path.join(OUT, "rust", safe(f"{p['name']}-{p['version']}"))
            os.makedirs(dest, exist_ok=True)
            authors = ", ".join(p.get("authors") or []) or "(sem autores no Cargo.toml)"
            lines = [
                f"{p['name']} {p['version']}",
                f"License (SPDX, declared in Cargo.toml): {p['license']}",
                f"Authors: {authors}",
                f"Repository: {p.get('repository') or p.get('homepage') or '-'}",
                "The crate ships no license file; the license text is the standard text of the SPDX id above.",
            ]
            open(os.path.join(dest, "LICENSE-DECLARED.txt"), "w", encoding="utf-8").write(NL.join(lines) + NL)
            index.append(TAB.join(["rust", p["name"], p["version"], f"declarada ({p['license']})"]))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    OUT = os.path.abspath(sys.argv[1])
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    go()
    npm()
    rust()
    open(os.path.join(OUT, "index.txt"), "w", encoding="utf-8").write("\n".join(sorted(index)) + "\n")
    # um arquivo só, para o instalador (que extrai arquivos soltos)
    with open(os.path.join(OUT, "THIRD-PARTY-LICENSES.txt"), "w", encoding="utf-8") as agg:
        agg.write("Licenses of third-party software in Beth Studio. Summary: THIRD-PARTY-NOTICES.md" + NL + NL)
        for root, _dirs, files in sorted(os.walk(OUT)):
            for f in sorted(files):
                if f in ("index.txt", "THIRD-PARTY-LICENSES.txt"):
                    continue
                rel = os.path.relpath(os.path.join(root, f), OUT).replace(chr(92), "/")
                agg.write("=" * 78 + NL + rel + NL + "=" * 78 + NL)
                agg.write(open(os.path.join(root, f), encoding="utf-8", errors="replace").read().rstrip() + NL + NL)
    print(f"{len(index)} dependências; licenças em {OUT}")
    if missing:
        print("SEM ARQUIVO DE LICENÇA:\n  " + "\n  ".join(missing), file=sys.stderr)
        sys.exit(1)
