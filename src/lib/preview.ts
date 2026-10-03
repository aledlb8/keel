/**
 * Files the editor shows rather than edits, and the Rust behind them.
 *
 * A binary file gets a viewer by what it is: its name says so for most media,
 * and its first bytes (sniffed in Rust) for the rest — a database is a
 * database whatever it is called. Anything unrecognised is shown as bytes.
 */

import { invoke } from "./invoke.ts";

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "font" | "sqlite" | "hex";

const BY_EXTENSION: Record<string, Exclude<PreviewKind, "sqlite" | "hex">> = {};
for (const [kind, extensions] of [
  ["image", "png apng jpg jpeg jfif pjpeg pjp gif webp avif bmp ico cur"],
  ["video", "mp4 m4v webm mov mkv ogv"],
  ["audio", "mp3 wav ogg oga opus flac m4a aac weba"],
  ["pdf", "pdf"],
  ["font", "ttf otf woff woff2"],
] as const) {
  for (const ext of extensions.split(" ")) BY_EXTENSION[ext] = kind;
}

const SNIFFED = new Set<string>(["image", "video", "audio", "pdf", "font", "sqlite"]);

export function extensionOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/**
 * The viewer for a binary file. A sniffed database wins outright; otherwise
 * the name decides, then the sniff, then bytes.
 */
export function previewKind(rel: string, format?: string | null): PreviewKind {
  if (format === "sqlite") return "sqlite";
  const named = BY_EXTENSION[extensionOf(rel)];
  if (named) return named;
  if (format && SNIFFED.has(format)) return format as PreviewKind;
  return "hex";
}

export const PREVIEW_LABEL: Record<PreviewKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  font: "Font",
  sqlite: "SQLite",
  hex: "Binary",
};

/**
 * Where the webview fetches a project file. `base` is the scheme's root as
 * `convertFileSrc` spells it on this platform; `version` (the file's mtime)
 * makes an edit on disk a new URL, so the viewer shows it.
 */
export function previewUrl(base: string, root: string, rel: string, version: number): string {
  const query = new URLSearchParams({ root, rel, v: String(version) });
  return `${base}?${query.toString()}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The file on disk, for handing to the system. */
export function absolutePath(root: string, rel: string): string {
  if (/windows/i.test(navigator.userAgent)) {
    return `${root}\\${rel.replace(/\//g, "\\")}`;
  }
  return `${root}/${rel}`;
}

export interface HexRow {
  offset: string;
  /** Sixteen bytes as pairs, with a wider gap after the eighth. */
  hex: string;
  /** The same bytes as printable ASCII, `·` for the rest. */
  ascii: string;
}

/** A classic dump, sixteen bytes a row, starting at `base`. */
export function hexRows(bytes: Uint8Array, base = 0): HexRow[] {
  const rows: HexRow[] = [];
  for (let start = 0; start < bytes.length; start += 16) {
    let hex = "";
    let ascii = "";
    for (let index = 0; index < 16; index += 1) {
      if (index === 8) hex += " ";
      const byte = bytes[start + index];
      if (byte === undefined) {
        hex += index === 0 ? "  " : "   ";
        continue;
      }
      hex += `${index === 0 ? "" : " "}${byte.toString(16).padStart(2, "0")}`;
      ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "·";
    }
    rows.push({
      offset: (base + start).toString(16).padStart(8, "0"),
      hex,
      ascii,
    });
  }
  return rows;
}

/** Raw bytes from `offset`; Rust caps how many per call. */
export function workspaceReadBytes(
  root: string,
  rel: string,
  offset: number,
  length: number,
): Promise<ArrayBuffer> {
  return invoke("workspace_read_bytes", { root, rel, offset, length });
}

export interface SqliteColumn {
  name: string;
  declType: string;
  primaryKey: boolean;
  notNull: boolean;
}

export interface SqliteTable {
  name: string;
  kind: "table" | "view";
  columns: SqliteColumn[];
}

/** A cell: SQLite's value, with a blob reduced to its length. */
export type SqliteCell = string | number | null | { blob: number };

export interface SqliteRows {
  columns: string[];
  rows: SqliteCell[][];
  total: number | null;
  truncated: boolean;
}

export function sqliteTables(root: string, rel: string): Promise<SqliteTable[]> {
  return invoke("sqlite_tables", { root, rel });
}

export function sqliteRows(
  root: string,
  rel: string,
  table: string,
  offset: number,
  limit: number,
): Promise<SqliteRows> {
  return invoke("sqlite_rows", { root, rel, table, offset, limit });
}

export function sqliteQuery(root: string, rel: string, sql: string): Promise<SqliteRows> {
  return invoke("sqlite_query", { root, rel, sql });
}
