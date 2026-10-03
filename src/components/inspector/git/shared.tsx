/**
 * The pieces every page of the git panel is built from: a folding section, an
 * icon button that sits in a row, line counts, an author's monogram, a ref
 * chip, and the small dialog that asks for a name.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Check, ChevronRight, Cloud, GitBranch, Tag } from "lucide-react";
import { toast } from "sonner";

import { Fold } from "@/components/Fold";
import { LoadingRows } from "@/components/inspector/LoadingRows";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { nameHue, type RefLabel } from "@/lib/git";
import { cn } from "@/lib/utils";
import type { LineStat } from "@/lib/workspace";
import { useWorkspace, type GitMetaSection } from "@/state/workspace";

export const IS_WINDOWS = /Windows/i.test(navigator.userAgent);

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** Whether a click landed on a control inside a row rather than on the row. */
export function isControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest("button, input, textarea") !== null;
}

export function copy(text: string, what = "Copied") {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(what))
    .catch(() => {});
}

export function RowIcon({
  label,
  onClick,
  danger,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      data-danger={danger ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="k-icon-btn size-[22px] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "px-[calc(var(--keel-inset)+8px)] pb-1.5 pt-0.5 text-body leading-relaxed text-faint",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A quiet notice in the middle of an empty page. */
export function Empty({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: typeof GitBranch;
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 pb-4 pt-8 text-center">
      <span className="grid size-9 place-items-center rounded-[var(--keel-r-control)] bg-veil-2 shadow-[inset_0_1px_0_0_var(--keel-sheen)]">
        <Icon aria-hidden className="size-4 text-dim" />
      </span>
      <p className="mt-3 text-row text-dim">{title}</p>
      {detail ? (
        <p className="mt-1 max-w-[240px] text-body leading-relaxed text-faint">{detail}</p>
      ) : null}
      {children}
    </div>
  );
}

/** A heading that folds what is under it. Actions show on hover. */
export function Section({
  title,
  count,
  open,
  onToggle,
  actions,
  zone,
  children,
}: {
  title: string;
  count?: number | undefined;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode | undefined;
  /** Drop handlers, while this section would take what is being dragged. */
  zone?: (HTMLAttributes<HTMLElement> & { "data-drop"?: "true" | undefined }) | undefined;
  children: ReactNode;
}) {
  return (
    <section {...zone} className={cn("pb-1", zone && "k-drop-zone")}>
      <div className="group/section flex h-7 items-center gap-1 px-[var(--keel-inset)]">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--keel-r-chip)] pl-2 pr-1.5 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-faint transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          <span className="truncate text-small font-medium text-faint transition-colors group-hover/section:text-dim">
            {title}
          </span>
          {count ? <span className="k-count">{count}</span> : null}
        </button>
        {actions ? (
          <span className="flex shrink-0 items-center gap-px opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/section:opacity-100">
            {actions}
          </span>
        ) : null}
      </div>
      <Fold open={open}>{children}</Fold>
    </section>
  );
}

/** "+12 −3", or "binary". Nothing at all when there is nothing to count. */
export function Stat({ stat, className }: { stat: LineStat | null | undefined; className?: string }) {
  if (!stat) return null;
  if (stat.binary) {
    return <span className={cn("k-stat text-faint", className)}>bin</span>;
  }
  if (!stat.added && !stat.removed) return null;
  return (
    <span className={cn("k-stat", className)}>
      {stat.added ? <span className="k-stat-add">+{stat.added}</span> : null}
      {stat.removed ? <span className="k-stat-del">−{stat.removed}</span> : null}
    </span>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn("k-avatar", className)}
      style={{ ["--hue" as string]: nameHue(name) }}
    >
      {letter}
    </span>
  );
}

const REF_COLOR: Record<RefLabel["kind"], string> = {
  head: "var(--keel-text)",
  branch: "var(--keel-ansi-blue)",
  remote: "var(--keel-ansi-magenta)",
  tag: "var(--keel-working)",
};

export function RefChip({ label }: { label: RefLabel }) {
  const Icon = label.kind === "tag" ? Tag : label.kind === "remote" ? Cloud : GitBranch;
  return (
    <span
      className="k-ref"
      data-current={label.current}
      title={label.kind === "head" ? "Detached HEAD" : label.name}
      style={{ ["--ref" as string]: REF_COLOR[label.kind] }}
    >
      {label.current && label.kind === "branch" ? (
        <Check aria-hidden className="size-2.5 shrink-0" />
      ) : (
        <Icon aria-hidden className="size-2.5 shrink-0" />
      )}
      <span>{label.name}</span>
    </span>
  );
}

const META_LABELS: Record<GitMetaSection, string> = {
  branches: "branches",
  prs: "pull requests",
  history: "history",
  stashes: "stashes",
  tags: "tags",
  remotes: "remotes",
};

const META_REFRESH = {
  branches: "refreshBranches",
  prs: "refreshPrs",
  history: "refreshHistory",
  stashes: "refreshStashes",
  tags: "refreshTags",
  remotes: "refreshRemotes",
} as const satisfies Record<GitMetaSection, string>;

/** Loading rows until a section has something, then it, with any error above. */
export function MetaContent({
  section,
  loaded,
  rows,
  children,
}: {
  section: GitMetaSection;
  loaded: boolean;
  rows?: number;
  children: ReactNode;
}) {
  const error = useWorkspace((state) => state.metaErrors[section]);
  const loading = useWorkspace((state) => state.metaLoading[section]);
  if (!loaded && (!error || loading)) {
    return <LoadingRows label={`Loading ${META_LABELS[section]}`} rows={rows ?? 4} />;
  }
  return (
    <>
      {error ? (
        <Hint>
          {error}{" "}
          <button
            type="button"
            disabled={loading}
            className="underline"
            onClick={() => void useWorkspace.getState()[META_REFRESH[section]]()}
          >
            Retry
          </button>
        </Hint>
      ) : null}
      {loaded ? children : null}
    </>
  );
}

/** A filter well for the top of a page. */
export function FilterField({
  value,
  onChange,
  placeholder,
  icon: Icon,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  icon: typeof GitBranch;
  onSubmit?: () => void;
}) {
  return (
    <div className="k-field k-field-sm min-w-0 flex-1">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <input
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
          if (event.key === "Enter") onSubmit?.();
        }}
      />
    </div>
  );
}

// ---- Asking for a name ------------------------------------------------------

export interface PromptField {
  key: string;
  label: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
  /** May be left empty. */
  optional?: boolean;
  /** Applied as you type: a branch name turns spaces into dashes. */
  transform?: (value: string) => string;
}

export interface PromptSpec {
  title: string;
  detail?: ReactNode;
  confirm: string;
  fields: PromptField[];
  onSubmit: (values: Record<string, string>) => void;
}

const PromptContext = createContext<(spec: PromptSpec) => void>(() => {});

export function usePrompt() {
  return useContext(PromptContext);
}

/** Branch and tag names cannot hold spaces; turn them into the usual dash. */
export const refName = (value: string) => value.replace(/\s/g, "-");

export function PromptHost({ children }: { children: ReactNode }) {
  const [spec, setSpec] = useState<PromptSpec | null>(null);
  return (
    <PromptContext.Provider value={setSpec}>
      {children}
      <Dialog open={spec !== null} onOpenChange={(open) => !open && setSpec(null)}>
        {spec ? <PromptBody spec={spec} onClose={() => setSpec(null)} /> : null}
      </Dialog>
    </PromptContext.Provider>
  );
}

function PromptBody({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.map((field) => [field.key, field.initial ?? ""])),
  );
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // Select what is there, so a rename can be typed straight over.
    requestAnimationFrame(() => first.current?.select());
  }, []);
  const ready = spec.fields.every(
    (field) => field.optional || (values[field.key] ?? "").trim().length > 0,
  );
  const submit = () => {
    if (!ready) return;
    onClose();
    spec.onSubmit(
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])),
    );
  };

  return (
    <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[380px]">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1.5 px-5 pb-3 pt-5">
          <DialogTitle>{spec.title}</DialogTitle>
          {spec.detail ? (
            <DialogDescription className="text-body">{spec.detail}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{spec.title}</DialogDescription>
          )}
        </div>
        <div className="flex flex-col gap-2.5 px-5 pb-4">
          {spec.fields.map((field, index) => (
            <label key={field.key} className="flex flex-col gap-1.5">
              <span className="text-small font-medium text-faint">
                {field.label}
                {field.optional ? <span className="font-normal"> · optional</span> : null}
              </span>
              {field.multiline ? (
                <div className="k-composer">
                  <textarea
                    rows={3}
                    value={values[field.key] ?? ""}
                    placeholder={field.placeholder}
                    onChange={(event) =>
                      setValues({ ...values, [field.key]: event.target.value })
                    }
                    className="pb-2"
                  />
                </div>
              ) : (
                <div className="k-field">
                  <input
                    ref={index === 0 ? first : undefined}
                    autoFocus={index === 0}
                    spellCheck={false}
                    value={values[field.key] ?? ""}
                    placeholder={field.placeholder}
                    onChange={(event) => {
                      const raw = event.target.value;
                      setValues({
                        ...values,
                        [field.key]: field.transform ? field.transform(raw) : raw,
                      });
                    }}
                  />
                </div>
              )}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-1.5 border-t border-line px-4 py-3">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!ready}>
            {spec.confirm}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

/** A tick box that reads as part of the chrome. */
export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-w-0 items-center gap-2 whitespace-nowrap text-left text-body text-dim hover:text-foreground"
    >
      <span className="k-check" aria-checked={checked}>
        {checked ? <Check aria-hidden strokeWidth={3} className="size-2.5" /> : null}
      </span>
      {children}
    </button>
  );
}
