/** Pick a CodeMirror language, or a readable name for one, from a relative path. */

import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { less } from "@codemirror/lang-less";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sass } from "@codemirror/lang-sass";
import { sql } from "@codemirror/lang-sql";
import { vue } from "@codemirror/lang-vue";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import {
  csharp,
  dart,
  kotlin,
  objectiveC,
  scala,
} from "@codemirror/legacy-modes/mode/clike";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { scheme } from "@codemirror/legacy-modes/mode/scheme";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";

function extensionOf(rel: string): string {
  const name = rel.split(/[\\/]/).pop() ?? rel;
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

function baseNameOf(rel: string): string {
  const name = rel.split(/[\\/]/).pop() ?? rel;
  return name.toLowerCase();
}

function stream<T>(parser: StreamParser<T>): Extension {
  return StreamLanguage.define(parser);
}

export function languageFor(rel: string): Extension | null {
  switch (baseNameOf(rel)) {
    case "dockerfile":
      return stream(dockerFile);
    case "jenkinsfile":
      return stream(groovy);
    case "gemfile":
    case "rakefile":
    case "vagrantfile":
    case "brewfile":
      return stream(ruby);
    case "cmakelists.txt":
      return stream(cmake);
    default:
      break;
  }
  switch (extensionOf(rel)) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "coffee":
      return stream(coffeeScript);
    case "json":
    case "jsonc":
      return json();
    case "html":
    case "htm":
      return html();
    case "vue":
      return vue();
    case "css":
      return css();
    case "scss":
      return sass();
    case "sass":
      return sass({ indented: true });
    case "less":
      return less();
    case "py":
    case "pyi":
      return python();
    case "rb":
    case "rake":
    case "gemspec":
      return stream(ruby);
    case "pl":
    case "pm":
      return stream(perl);
    case "rs":
      return rust();
    case "go":
      return go();
    case "java":
      return java();
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "c++":
    case "hpp":
    case "hh":
    case "hxx":
    case "ino":
      return cpp();
    case "cs":
    case "csx":
      return stream(csharp);
    case "kt":
    case "kts":
      return stream(kotlin);
    case "swift":
      return stream(swift);
    case "dart":
      return stream(dart);
    case "scala":
      return stream(scala);
    case "m":
    case "mm":
      return stream(objectiveC);
    case "php":
    case "phtml":
      return php();
    case "sql":
      return sql();
    case "lua":
      return stream(lua);
    case "r":
      return stream(r);
    case "jl":
      return stream(julia);
    case "hs":
      return stream(haskell);
    case "erl":
    case "hrl":
      return stream(erlang);
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return stream(clojure);
    case "scm":
    case "ss":
    case "rkt":
      return stream(scheme);
    case "sh":
    case "bash":
    case "zsh":
    case "ksh":
      return stream(shell);
    case "ps1":
    case "psm1":
      return stream(powerShell);
    case "toml":
      return stream(toml);
    case "properties":
    case "ini":
    case "cfg":
    case "conf":
    case "env":
      return stream(properties);
    case "diff":
    case "patch":
      return stream(diff);
    case "gradle":
    case "groovy":
      return stream(groovy);
    case "proto":
      return stream(protobuf);
    case "cmake":
      return stream(cmake);
    case "md":
    case "mdx":
      return markdown();
    case "yml":
    case "yaml":
      return yaml();
    case "xml":
    case "svg":
      return xml();
    default:
      return null;
  }
}

const NAMES: Record<string, string> = {
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript JSX",
  coffee: "CoffeeScript",
  json: "JSON",
  jsonc: "JSON",
  html: "HTML",
  htm: "HTML",
  vue: "Vue",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "LESS",
  py: "Python",
  pyi: "Python",
  rb: "Ruby",
  rake: "Ruby",
  gemspec: "Ruby",
  pl: "Perl",
  pm: "Perl",
  rs: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  h: "C Header",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  "c++": "C++",
  hpp: "C++ Header",
  hh: "C++ Header",
  hxx: "C++ Header",
  ino: "Arduino",
  cs: "C#",
  csx: "C#",
  kt: "Kotlin",
  kts: "Kotlin",
  swift: "Swift",
  dart: "Dart",
  scala: "Scala",
  m: "Objective-C",
  mm: "Objective-C++",
  php: "PHP",
  phtml: "PHP",
  sql: "SQL",
  lua: "Lua",
  r: "R",
  jl: "Julia",
  hs: "Haskell",
  erl: "Erlang",
  hrl: "Erlang",
  clj: "Clojure",
  cljs: "ClojureScript",
  cljc: "Clojure",
  edn: "EDN",
  scm: "Scheme",
  ss: "Scheme",
  rkt: "Racket",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ksh: "Shell",
  ps1: "PowerShell",
  psm1: "PowerShell",
  toml: "TOML",
  properties: "Properties",
  ini: "INI",
  cfg: "INI",
  conf: "INI",
  env: "Env",
  diff: "Diff",
  patch: "Diff",
  gradle: "Gradle",
  groovy: "Groovy",
  proto: "Protocol Buffers",
  cmake: "CMake",
  md: "Markdown",
  mdx: "MDX",
  yml: "YAML",
  yaml: "YAML",
  xml: "XML",
  svg: "SVG",
};

export function languageName(rel: string): string {
  return NAMES[extensionOf(rel)] ?? "Plain text";
}
