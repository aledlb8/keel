/**
 * A SQLite database, read-only: its tables down the side, the chosen one a
 * page at a time, and a query box for anything a table page cannot show.
 *
 * Nothing here writes. Rust opens the file read-only and refuses a query that
 * would change it, so this is a safe look even at a database an app is using.
 * When the file changes on disk the list and the page re-read in place.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Eye, KeyRound, Play, Table2, TerminalSquare } from "lucide-react";

import { DockNotice } from "@/components/Dock";
import { LoadingRows } from "@/components/inspector/LoadingRows";
import {
  errorMessage,
  formatBytes,
  sqliteQuery,
  sqliteRows,
  sqliteTables,
  type SqliteCell,
  type SqliteRows,
  type SqliteTable,
} from "@/lib/preview";
import { cn } from "@/lib/utils";

const PAGE = 100;
/** The side list's pseudo-entry for the query box. */
const QUERY = Symbol("query");

type Selection = string | typeof QUERY;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function SqliteView({
  root,
  rel,
  version,
}: {
  root: string;
  rel: string;
  /** The file's mtime: a change re-reads what is on screen. */
  version: number;
}) {
  const [tables, setTables] = useState<SqliteTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);

  useEffect(() => {
    let cancelled = false;
    sqliteTables(root, rel).then(
      (listed) => {
        if (cancelled) return;
        setTables(listed);
        setError(null);
        setSelected((current) =>
          current === QUERY || (current && listed.some((table) => table.name === current))
            ? current
            : (listed[0]?.name ?? QUERY),
        );
      },
      (err) => {
        if (!cancelled) setError(errorMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [root, rel, version]);

  if (error) {
    return (
      <DockNotice
        icon={Table2}
        title="Couldn't open this database"
        detail={error}
        className="h-full justify-center"
      />
    );
  }
  if (!tables || selected === null) return <LoadingRows label="Opening database" rows={10} />;

  const table = typeof selected === "string" ? tables.find((t) => t.name === selected) : undefined;
  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Tables"
        className="flex w-44 shrink-0 flex-col gap-px overflow-y-auto border-r border-[color:var(--keel-term-border)] p-1.5"
      >
        <SideItem
          active={selected === QUERY}
          onClick={() => setSelected(QUERY)}
          icon={<TerminalSquare className="size-3.5" />}
          label="Query"
        />
        <p className="px-2 pb-1 pt-2.5 text-micro font-medium uppercase tracking-wide text-faint">
          {tables.length === 0 ? "No tables" : `Tables · ${tables.length}`}
        </p>
        {tables.map((entry) => (
          <SideItem
            key={entry.name}
            active={selected === entry.name}
            onClick={() => setSelected(entry.name)}
            icon={
              entry.kind === "view" ? (
                <Eye className="size-3.5" />
              ) : (
                <Table2 className="size-3.5" />
              )
            }
            label={entry.name}
            title={entry.kind === "view" ? `${entry.name} (view)` : entry.name}
          />
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected === QUERY ? (
          <QueryPanel
            root={root}
            rel={rel}
            starter={tables[0] ? `SELECT * FROM ${quoteIdent(tables[0].name)} LIMIT 100` : ""}
          />
        ) : table ? (
          <TablePanel key={table.name} root={root} rel={rel} table={table} version={version} />
        ) : null}
      </div>
    </div>
  );
}

function SideItem({
  active,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      data-active={active}
      onClick={onClick}
      className={cn(
        "flex h-[var(--keel-h-chip)] shrink-0 items-center gap-2 rounded-[var(--keel-r-chip)] px-2 text-left text-body transition-colors",
        active ? "bg-veil-3 text-foreground" : "text-dim hover:bg-veil hover:text-foreground",
      )}
    >
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/** One table, a page at a time. */
function TablePanel({
  root,
  rel,
  table,
  version,
}: {
  root: string;
  rel: string;
  table: SqliteTable;
  version: number;
}) {
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<SqliteRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    sqliteRows(root, rel, table.name, page * PAGE, PAGE).then(
      (rows) => {
        if (cancelled) return;
        setResult(rows);
        setError(null);
        setBusy(false);
        // Rows were deleted under us: step back to the last page that has any.
        const pages = Math.max(1, Math.ceil((rows.total ?? 0) / PAGE));
        if (page >= pages) setPage(pages - 1);
      },
      (err) => {
        if (cancelled) return;
        setError(errorMessage(err));
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [root, rel, table.name, page, version]);

  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const first = total === 0 ? 0 : page * PAGE + 1;
  const last = Math.min(total, (page + 1) * PAGE);

  return (
    <>
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="p-4 text-body text-[color:var(--keel-dead)]">{error}</p>
        ) : !result ? (
          <LoadingRows label="Loading rows" rows={10} />
        ) : (
          <ResultGrid result={result} table={table} dimmed={busy} />
        )}
      </div>
      <footer className="flex h-[var(--keel-h-row)] shrink-0 items-center gap-2 border-t border-[color:var(--keel-term-border)] px-3 text-small text-faint">
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {table.kind === "view" ? "View · " : ""}
          {total === 0 ? "No rows" : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
        </span>
        <button
          type="button"
          title="Previous page"
          aria-label="Previous page"
          className="k-icon-btn size-6"
          disabled={page === 0}
          onClick={() => setPage((value) => Math.max(0, value - 1))}
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <span className="tabular-nums">
          {page + 1} / {pages}
        </span>
        <button
          type="button"
          title="Next page"
          aria-label="Next page"
          className="k-icon-btn size-6"
          disabled={page + 1 >= pages}
          onClick={() => setPage((value) => value + 1)}
        >
          <ChevronRight className="size-3.5" />
        </button>
      </footer>
    </>
  );
}

/** A query box over its result. Ctrl+Enter runs it. */
function QueryPanel({ root, rel, starter }: { root: string; rel: string; starter: string }) {
  const [sql, setSql] = useState(starter);
  const [result, setResult] = useState<SqliteRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);

  const execute = useCallback(async () => {
    const id = ++run.current;
    setBusy(true);
    try {
      const rows = await sqliteQuery(root, rel, sql);
      if (id !== run.current) return;
      setResult(rows);
      setError(null);
    } catch (err) {
      if (id === run.current) setError(errorMessage(err));
    } finally {
      if (id === run.current) setBusy(false);
    }
  }, [root, rel, sql]);

  return (
    <>
      <div className="shrink-0 border-b border-[color:var(--keel-term-border)] p-2">
        <div className="k-composer">
          <textarea
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void execute();
              }
            }}
            rows={4}
            spellCheck={false}
            aria-label="SQL query"
            placeholder="SELECT * FROM …"
            className="block w-full resize-y bg-transparent px-2.5 pt-2 font-mono text-body text-foreground outline-none placeholder:text-faint"
          />
          <div className="flex items-center gap-2 px-2 pb-1.5">
            <span className="min-w-0 flex-1 truncate text-micro text-faint">
              Read-only · Ctrl+Enter to run
            </span>
            <button
              type="button"
              className="k-tag gap-1"
              disabled={busy || !sql.trim()}
              onClick={() => void execute()}
            >
              <Play className="size-2.5" />
              {busy ? "Running…" : "Run"}
            </button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="whitespace-pre-wrap p-4 font-mono text-body text-[color:var(--keel-dead)]">
            {error}
          </p>
        ) : result ? (
          <ResultGrid result={result} dimmed={busy} />
        ) : (
          <p className="p-4 text-body text-faint">Run a query to see its rows.</p>
        )}
      </div>
      {result && !error ? (
        <footer className="flex h-[var(--keel-h-row)] shrink-0 items-center border-t border-[color:var(--keel-term-border)] px-3 text-small text-faint tabular-nums">
          {result.rows.length === 0
            ? "No rows"
            : `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? "" : "s"}${
                result.truncated ? ", and more not shown" : ""
              }`}
        </footer>
      ) : null}
    </>
  );
}

function ResultGrid({
  result,
  table,
  dimmed,
}: {
  result: SqliteRows;
  table?: SqliteTable;
  dimmed: boolean;
}) {
  const described = new Map(table?.columns.map((column) => [column.name, column]));
  if (result.columns.length === 0) {
    return <p className="p-4 text-body text-faint">Nothing to show.</p>;
  }
  return (
    <div className={cn("h-full overflow-auto transition-opacity", dimmed && "opacity-60")}>
      <table className="min-w-full border-separate border-spacing-0 font-mono text-small">
        <thead>
          <tr>
            {result.columns.map((name, index) => {
              const column = described.get(name);
              return (
                <th
                  key={`${index}:${name}`}
                  scope="col"
                  className="sticky top-0 z-10 h-7 whitespace-nowrap border-b border-r border-[color:var(--keel-term-border)] bg-[color:var(--keel-term-solid)] px-2.5 text-left font-sans font-medium text-dim"
                >
                  <span className="flex items-center gap-1.5">
                    {column?.primaryKey ? (
                      <KeyRound aria-label="Primary key" className="size-3 text-faint" />
                    ) : null}
                    {name}
                    {column?.declType ? (
                      <span className="font-mono text-micro font-normal text-faint">
                        {column.declType.toLowerCase()}
                      </span>
                    ) : null}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-veil">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className="h-6 max-w-[24rem] truncate whitespace-nowrap border-b border-r border-[color:var(--keel-line)] px-2.5"
                  title={typeof cell === "string" ? cell : undefined}
                >
                  <Cell value={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ value }: { value: SqliteCell }) {
  if (value === null) return <span className="italic text-faint">NULL</span>;
  if (typeof value === "number") {
    return <span className="block text-right tabular-nums text-[color:var(--keel-ansi-blue)]">{value}</span>;
  }
  if (typeof value === "object") {
    return <span className="text-faint">BLOB · {formatBytes(value.blob)}</span>;
  }
  return <span className="text-[color:var(--keel-term-fg)]">{value}</span>;
}
