// Realce de código do painel de arquivo. Sem dependência: um passe só,
// comentário e string ganham do resto. .mika/.crs usam as palavras do Copper.

export type CodeTok = "kw" | "decl" | "mod" | "str" | "com" | "doc" | "num" | "fn" | "macro" | "type" | "prim" | "plain";

export interface CodeSeg {
  text: string;
  tok: CodeTok;
}

const C_LIKE = ["if", "else", "for", "while", "return", "break", "continue", "switch", "case", "default", "struct", "enum", "const", "static", "true", "false", "null", "new", "this", "class", "public", "private", "void"];

interface LangSpec {
  /** linguagens sem a gramática do Copper: tudo vira keyword.control */
  kw?: string[];
  /** keyword.control — Dark+ #C586C0 */
  control?: string[];
  /** keyword.declaration — Dark+ #569CD6 */
  decl?: string[];
  /** storage.modifier — Dark+ #569CD6 */
  mod?: string[];
  /** constant.language */
  lit?: string[];
  /** support.type.primitive — Dark+ #4EC9B0 */
  prim?: string[];
  types?: string[];
  /** entity.name.type: identificador com inicial maiúscula */
  capType?: boolean;
  line?: string;
  doc?: boolean;
  block?: [string, string];
  hash?: boolean;
  /** chamada name( vira entity.name.function */
  call?: boolean;
  /** name! vira macro */
  macro?: boolean;
}

const LANG: Record<string, LangSpec> = {
  // Escopos de editors/vscode/syntaxes/copper.tmLanguage.json.
  // Cores do Dark+ do VS Code, que a extensão usa.
  crs: {
    control: ["if", "else", "guard", "defer", "match", "loop", "while", "for", "in", "break", "continue", "return", "yield"],
    decl: ["func", "struct", "class", "impl", "trait", "enum", "let", "import", "from", "as", "use", "type", "mod"],
    mod: ["pub", "public", "unsafe", "extern", "async", "await", "static", "const", "dyn", "where", "mut", "ref", "move", "own"],
    lit: ["true", "false", "null", "None", "Some", "Ok", "Err", "self", "Self", "super", "crate"],
    prim: ["int", "float", "str", "string", "bool", "void", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "usize", "isize", "char"],
    capType: true,
    line: "//",
    doc: true,
    block: ["/*", "*/"],
    call: true,
    macro: true,
  },
  mui: {
    kw: ["view", "func", "struct", "class", "impl", "trait", "enum", "import", "from", "as", "use", "if", "else", "match", "for", "in", "effect", "return", "mut", "pub", "ref", "move", "unsafe", "async", "await", "static", "const", "dyn", "where", "signal", "computed", "true", "false", "null", "None", "Some", "Ok", "Err", "self", "Self"],
    types: ["App", "Text", "Button", "Column", "Row", "Stack", "Box", "Image", "Scroll", "Spacer"],
    line: "//",
    block: ["/*", "*/"],
  },
  rust: {
    kw: ["fn", "let", "mut", "const", "struct", "enum", "impl", "trait", "type", "pub", "use", "mod", "if", "else", "match", "loop", "while", "for", "break", "continue", "return", "async", "await", "move", "dyn", "unsafe", "where", "self", "Self", "true", "false", "as", "in"],
    types: ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "bool", "str", "String", "Vec", "Option", "Result"],
    line: "//",
    block: ["/*", "*/"],
  },
  go: {
    kw: ["func", "package", "import", "var", "const", "type", "struct", "interface", "if", "else", "for", "range", "switch", "case", "default", "return", "break", "continue", "go", "defer", "select", "chan", "map", "true", "false", "nil"],
    types: ["int", "int8", "int16", "int32", "int64", "uint", "string", "bool", "byte", "rune", "error", "float32", "float64"],
    line: "//",
    block: ["/*", "*/"],
  },
  python: {
    kw: ["def", "class", "if", "elif", "else", "for", "while", "return", "import", "from", "as", "try", "except", "finally", "with", "yield", "lambda", "pass", "break", "continue", "True", "False", "None", "and", "or", "not", "in", "is", "async", "await"],
    hash: true,
  },
  js: {
    kw: ["function", "const", "let", "var", "if", "else", "for", "while", "return", "class", "extends", "new", "this", "import", "export", "from", "async", "await", "try", "catch", "finally", "throw", "true", "false", "null", "undefined", "of", "in", "typeof"],
    line: "//",
    block: ["/*", "*/"],
  },
  c: { kw: [...C_LIKE, "typedef", "sizeof", "int", "char", "float", "double", "long", "short", "unsigned", "signed", "#include", "#define", "#ifdef", "#ifndef", "#endif", "#pragma"], line: "//", block: ["/*", "*/"] },
  java: { kw: [...C_LIKE, "package", "import", "extends", "implements", "interface", "throws", "try", "catch", "finally", "boolean", "int", "long", "double"], line: "//", block: ["/*", "*/"] },
  shell: { kw: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "exit", "echo", "export", "local", "in"], hash: true },
  sql: { kw: ["select", "from", "where", "and", "or", "insert", "into", "values", "update", "set", "delete", "create", "table", "join", "left", "right", "inner", "on", "group", "by", "order", "limit", "as", "null", "not", "in"], line: "--" },
  json: { kw: ["true", "false", "null"] },
  html: { kw: [], block: ["<!--", "-->"] },
  css: { kw: [], block: ["/*", "*/"] },
  yaml: { kw: ["true", "false", "null", "yes", "no"], hash: true },
  toml: { kw: ["true", "false"], hash: true },
  plain: { kw: [] },
};

const EXT_LANG: Record<string, string> = {
  crs: "crs", mika: "crs", kson: "json", kmodel: "json", mui: "mui", rs: "rust", go: "go", py: "python", js: "js", jsx: "js", mjs: "js", cjs: "js",
  ts: "js", tsx: "js", c: "c", h: "c", cpp: "c", cc: "c", hpp: "c", hh: "c", java: "java", kt: "java",
  cs: "java", swift: "java", php: "java", scala: "java", dart: "java",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "shell",
  sql: "sql", json: "json", jsonl: "json", html: "html", htm: "html", vue: "html", css: "css", scss: "css",
  yaml: "yaml", yml: "yaml", toml: "toml", xml: "html",
};

export function langOf(name: string): string {
  const low = name.toLowerCase();
  if (low === "app.bundle") return "json";
  const ext = low.includes(".") ? low.slice(low.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext] ?? "plain";
}

export function highlightCode(src: string, lang: string): CodeSeg[] {
  const spec = LANG[lang] ?? LANG.plain;
  const control = new Set(spec.control ?? spec.kw ?? []);
  const decl = new Set(spec.decl ?? []);
  const mod = new Set(spec.mod ?? []);
  const lit = new Set(spec.lit ?? []);
  const prim = new Set(spec.prim ?? spec.types ?? []);
  const out: CodeSeg[] = [];
  const push = (text: string, tok: CodeTok) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.tok === tok) last.text += text;
    else out.push({ text, tok });
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    if (spec.doc && (rest.startsWith("///") || rest.startsWith("//!"))) {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      push(src.slice(i, end), "doc");
      i = end;
      continue;
    }
    if (spec.line && rest.startsWith(spec.line)) {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      push(src.slice(i, end), "com");
      i = end;
      continue;
    }
    if (spec.hash && src[i] === "#") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      push(src.slice(i, end), "com");
      i = end;
      continue;
    }
    if (spec.block && rest.startsWith(spec.block[0])) {
      const close = src.indexOf(spec.block[1], i + spec.block[0].length);
      const end = close < 0 ? src.length : close + spec.block[1].length;
      push(src.slice(i, end), "com");
      i = end;
      continue;
    }
    const q = src[i];
    if (q === '"' || q === "'" || q === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== q && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      if (j < src.length && src[j] === q) j++;
      push(src.slice(i, j), "str");
      i = j;
      continue;
    }
    if (/[0-9]/.test(q) && (i === 0 || !/[A-Za-z_]/.test(src[i - 1]))) {
      let j = i + 1;
      while (j < src.length && /[0-9.xXa-fA-F_]/.test(src[j])) j++;
      push(src.slice(i, j), "num");
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(q)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < src.length && /[ \t]/.test(src[k])) k++;
      const call = src[k] === "(";
      const afterBang = src.slice(j + 1).trimStart();
      const macro = !!spec.macro && src[j] === "!" && /[([{]/.test(afterBang[0] ?? "");
      let tok: CodeTok = "plain";
      if (control.has(word)) tok = "kw";
      else if (decl.has(word)) tok = "decl";
      else if (mod.has(word)) tok = "mod";
      else if (lit.has(word)) tok = "kw";
      else if (prim.has(word)) tok = "prim";
      else if (spec.capType && /^[A-Z]/.test(word)) tok = "type";
      else if (macro) tok = "macro";
      else if (call && (spec.call || spec.kw)) tok = "fn";
      push(word, tok);
      i = j;
      continue;
    }
    push(q, "plain");
    i++;
  }
  return out;
}
