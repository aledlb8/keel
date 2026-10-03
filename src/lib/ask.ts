/**
 * Ask before something that cannot be undone.
 *
 * `window.confirm` cannot be trusted here: Tauri's dialog plugin replaces it
 * with an async function, so it returns a promise — always truthy — and every
 * "are you sure?" written as `if (window.confirm(...))` went ahead without
 * asking. This asks in Keel's own dialog and resolves to the answer.
 *
 * Where no dialog is mounted (the tests), it falls back to `window.confirm`
 * and awaits whatever that returns; a fallback that fails counts as "no".
 */

export interface AskOptions {
  title?: string;
  /** The button that goes ahead. */
  confirm?: string;
  /** Paint the go-ahead button as destructive. */
  destructive?: boolean;
}

type Asker = (message: string, options: AskOptions) => Promise<boolean>;

let asker: Asker | null = null;

/** Mount the dialog that answers `ask`; null unmounts it. */
export function setAsker(next: Asker | null): void {
  asker = next;
}

export async function ask(message: string, options: AskOptions = {}): Promise<boolean> {
  if (asker) return asker(message, options);
  const fallback = (globalThis as { window?: { confirm?: (text: string) => unknown } }).window
    ?.confirm;
  if (!fallback) return false;
  try {
    return (await fallback(message)) === true;
  } catch {
    return false;
  }
}
