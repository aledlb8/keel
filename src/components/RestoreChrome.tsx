/**
 * S10 reopen chrome + IPC host-lost banner.
 *
 * Restoring… is a whisper; Failed is a centered panel with Retry / Reset layout.
 * Partial reopen is pane-level (dead edge + Relaunch) — no blank canvas.
 */

import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { useKeel } from "@/state/store";

export function RestoreChrome() {
  const ready = useKeel((state) => state.ready);
  const restoreStatus = useKeel((state) => state.restoreStatus);
  const hostLost = useKeel((state) => state.hostLost);

  const showRestoring =
    !ready || restoreStatus === "restoring";
  const showFailed = ready && restoreStatus === "failed";

  return (
    <>
      {hostLost ? (
        <div
          className="k-glass absolute inset-x-0 top-0 z-50 flex items-center justify-between gap-3 border-b border-line px-4 py-2"
          role="alert"
        >
          <div className="min-w-0">
            <p className="text-[14px] text-foreground">Connection lost</p>
            <p className="mt-0.5 text-[13px] leading-snug text-dim">
              The Keel host stopped responding. Terminals keep running.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void backend
                .detectAgents()
                .then(() => useKeel.getState().clearHostLost())
                .catch(() => {
                  /* Stay lost until a call succeeds. */
                });
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {showRestoring ? (
        <div
          className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-scrim backdrop-blur-[var(--keel-blur)]"
          aria-live="polite"
          aria-busy="true"
        >
          <p className="rounded-[var(--keel-r-control)] border border-line-strong bg-[color:var(--keel-chrome-strong)] px-3.5 py-2 text-[13px] text-dim shadow-[var(--keel-lift)] backdrop-blur-[var(--keel-blur)]">
            Restoring layout…
          </p>
        </div>
      ) : null}

      {showFailed ? (
        <div className="absolute inset-0 z-40 grid place-items-center bg-scrim backdrop-blur-[var(--keel-blur-strong)]">
          <div className="w-[320px] rounded-[var(--keel-r-window)] border border-line-strong bg-[color:var(--keel-chrome-strong)] px-5 py-5 text-center shadow-[var(--keel-lift-strong)] backdrop-blur-[var(--keel-blur-strong)]">
            <p className="text-[15px] text-foreground">
              Couldn&apos;t restore your layout
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-dim">
              Last session&apos;s file didn&apos;t load cleanly. Retry it, or
              start from an empty deck.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void useKeel.getState().retryRestore()}
              >
                Retry
              </Button>
              <Button
                size="sm"
                onClick={() => useKeel.getState().resetLayout()}
              >
                Reset layout
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}