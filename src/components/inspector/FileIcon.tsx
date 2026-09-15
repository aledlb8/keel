/**
 * A glyph for a file or folder, picked from its name.
 *
 * Deliberately a handful of shapes and no colour. The chrome spends colour on
 * status alone, and in a tree of forty files a rainbow of language logos is
 * exactly the noise that rule exists to prevent. Shape is enough to tell code
 * from data from prose at a glance.
 */

import {
  Braces,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Lock,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

const CODE = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "rs", "py", "go",
  "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php",
  "sh", "bash", "zsh", "ps1", "lua", "zig", "vue", "svelte", "css", "scss",
  "html", "htm", "sql",
]);
const DATA = new Set([
  "json", "jsonc", "json5", "toml", "yaml", "yml", "xml", "ini", "csv",
]);
const PROSE = new Set(["md", "mdx", "txt", "rst", "adoc"]);
const IMAGE = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif",
]);
const LOCKFILES = new Set([
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb",
]);

export function fileGlyph(name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (LOCKFILES.has(lower) || lower.endsWith(".lock")) return Lock;
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (CODE.has(ext)) return FileCode2;
  if (DATA.has(ext)) return Braces;
  if (PROSE.has(ext)) return FileText;
  if (IMAGE.has(ext)) return FileImage;
  return File;
}

export function FileIcon({
  name,
  folder = false,
  open = false,
  className,
}: {
  name: string;
  folder?: boolean;
  open?: boolean;
  className?: string;
}) {
  const Icon = folder ? (open ? FolderOpen : Folder) : fileGlyph(name);
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        folder ? "text-dim" : "text-faint",
        className,
      )}
    />
  );
}
