/** Pick a CodeMirror language, or a readable name for one, from a relative path. */

import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";

function extensionOf(rel: string): string {
  const name = rel.split(/[\\/]/).pop() ?? rel;
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

export function languageFor(rel: string): Extension | null {
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
    case "json":
    case "jsonc":
      return json();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
      return css();
    case "py":
      return python();
    case "rs":
      return rust();
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
  json: "JSON",
  jsonc: "JSON",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  py: "Python",
  rs: "Rust",
  md: "Markdown",
  mdx: "MDX",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  svg: "SVG",
  sh: "Shell",
  ps1: "PowerShell",
};

export function languageName(rel: string): string {
  return NAMES[extensionOf(rel)] ?? "Plain text";
}
