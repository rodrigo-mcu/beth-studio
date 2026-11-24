// Marcas de arquivo do vscode-symbols (miguelsolorio/vscode-symbols), em SVG.
// .mika/.crs ficam de fora: usam a pomba do Copper.

import rust from "@/assets/symbols/rust.svg";
import c from "@/assets/symbols/c.svg";
import cpp from "@/assets/symbols/cpp.svg";
import h from "@/assets/symbols/h.svg";
import java from "@/assets/symbols/java.svg";
import go from "@/assets/symbols/go.svg";
import python from "@/assets/symbols/python.svg";
import js from "@/assets/symbols/js.svg";
import ts from "@/assets/symbols/ts.svg";
import react from "@/assets/symbols/react.svg";
import php from "@/assets/symbols/php.svg";
import ruby from "@/assets/symbols/ruby.svg";
import swift from "@/assets/symbols/swift.svg";
import kotlin from "@/assets/symbols/kotlin.svg";
import dart from "@/assets/symbols/dart.svg";
import lua from "@/assets/symbols/lua.svg";
import csharp from "@/assets/symbols/csharp.svg";
import vue from "@/assets/symbols/vue.svg";
import svelte from "@/assets/symbols/svelte.svg";
import docker from "@/assets/symbols/docker.svg";
import shell from "@/assets/symbols/shell.svg";
import zig from "@/assets/symbols/zig.svg";
import haskell from "@/assets/symbols/haskell.svg";
import elixir from "@/assets/symbols/elixir.svg";
import scala from "@/assets/symbols/scala.svg";
import perl from "@/assets/symbols/perl.svg";
import r from "@/assets/symbols/r.svg";
import cmake from "@/assets/symbols/cmake.svg";
import markdown from "@/assets/symbols/markdown.svg";
import readme from "@/assets/symbols/readme.svg";
import claude from "@/assets/symbols/claude.svg";
import yaml from "@/assets/symbols/yaml.svg";
import git from "@/assets/symbols/git.svg";
import image from "@/assets/symbols/image.svg";
import pdf from "@/assets/symbols/pdf.svg";
import zip from "@/assets/symbols/zip.svg";
import exe from "@/assets/symbols/exe.svg";
import text from "@/assets/symbols/text.svg";
import xml from "@/assets/symbols/xml.svg";
import lock from "@/assets/symbols/lock.svg";
import document from "@/assets/symbols/document.svg";
import gear from "@/assets/symbols/gear.svg";
import database from "@/assets/symbols/database.svg";
import font from "@/assets/symbols/font.svg";
import audio from "@/assets/symbols/audio.svg";
import video from "@/assets/symbols/video.svg";
import gif from "@/assets/symbols/gif.svg";
import svg from "@/assets/symbols/svg.svg";
import csv from "@/assets/symbols/csv.svg";
import gradle from "@/assets/symbols/gradle.svg";
import license from "@/assets/symbols/license.svg";
import http from "@/assets/symbols/http.svg";
import sass from "@/assets/symbols/sass.svg";
import dts from "@/assets/symbols/dts.svg";
import ignore from "@/assets/symbols/ignore.svg";
import graphql from "@/assets/symbols/graphql.svg";
import proto from "@/assets/symbols/proto.svg";
import folder from "@/assets/symbols/folder.svg";
import folderOpen from "@/assets/symbols/folder-open.svg";
import folderSrc from "@/assets/symbols/folder-src.svg";
import folderConfig from "@/assets/symbols/folder-config.svg";
import folderAssets from "@/assets/symbols/folder-assets.svg";
import folderDocs from "@/assets/symbols/folder-docs.svg";

const EXT: Record<string, string> = {
  rs: rust,
  c,
  h,
  hh: h,
  hpp: h,
  hxx: h,
  cpp,
  cc: cpp,
  cxx: cpp,
  java,
  class: java,
  kt: kotlin,
  kts: kotlin,
  go,
  py: python,
  pyi: python,
  js,
  mjs: js,
  cjs: js,
  jsx: react,
  ts,
  tsx: react,
  "d.ts": dts,
  php,
  rb: ruby,
  swift,
  dart,
  lua,
  cs: csharp,
  vue,
  svelte,
  zig,
  hs: haskell,
  ex: elixir,
  exs: elixir,
  scala,
  pl: perl,
  pm: perl,
  r,
  sh: shell,
  bash: shell,
  zsh: shell,
  fish: shell,
  ps1: shell,
  bat: exe,
  cmd: exe,
  exe,
  md: markdown,
  markdown,
  txt: text,
  log: text,
  rst: text,
  yaml,
  yml: yaml,
  xml,
  csv,
  png: image,
  jpg: image,
  jpeg: image,
  webp: image,
  bmp: image,
  ico: image,
  gif,
  svg,
  pdf,
  zip,
  tar: zip,
  gz: zip,
  tgz: zip,
  "7z": zip,
  rar: zip,
  lock,
  ttf: font,
  otf: font,
  woff: font,
  woff2: font,
  mp3: audio,
  wav: audio,
  flac: audio,
  ogg: audio,
  mp4: video,
  mov: video,
  mkv: video,
  webm: video,
  sql: database,
  db: database,
  sqlite: database,
  graphql,
  gql: graphql,
  proto,
  scss: sass,
  sass,
  http,
  gradle,
  gitignore: ignore,
  toml: gear,
};

const NAME: Record<string, string> = {
  dockerfile: docker,
  "docker-compose.yml": docker,
  "docker-compose.yaml": docker,
  makefile: cmake,
  "cmakelists.txt": cmake,
  "cargo.toml": rust,
  "cargo.lock": lock,
  "go.mod": go,
  "go.sum": go,
  "package.json": document,
  "tsconfig.json": ts,
  "license": license,
  "license.md": license,
  "readme.md": readme,
  "readme": readme,
  "claude.md": claude,
  "agents.md": claude,
  ".gitignore": ignore,
  ".env": gear,
};

const FOLDER: Record<string, string> = {
  src: folderSrc,
  source: folderSrc,
  config: folderConfig,
  configs: folderConfig,
  assets: folderAssets,
  images: folderAssets,
  img: folderAssets,
  docs: folderDocs,
  doc: folderDocs,
  documentation: folderDocs,
};

export function symbolForFile(name: string): string | null {
  const low = name.toLowerCase();
  if (NAME[low]) return NAME[low];
  if (low.endsWith(".d.ts")) return dts;
  const ext = low.includes(".") ? low.slice(low.lastIndexOf(".") + 1) : "";
  return EXT[ext] ?? null;
}

export function symbolForFolder(name: string, open: boolean): string {
  const low = name.toLowerCase();
  if (!open && FOLDER[low]) return FOLDER[low];
  return open ? folderOpen : folder;
}
