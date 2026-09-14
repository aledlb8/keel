/**
 * Power-up reopen chrome.
 *
 * While panes that already existed at launch are coming back, the canvas sits
 * under a scrim so nothing is typed into a half-started terminal. The words —
 * "Reopening terminals", "Connecting VPN", "Keel isn't responding" — live in
 * the top bar's island, the one place the window says what it is doing. Failed
 * is a centered panel with Retry / Reset layout. Partial reopen is pane-level
 * (dead edge + Relaunch).
 */

import { Button } from "@/components/ui/button";
import { useKeel } from "@/state/store";

export function RestoreChrome() {
  const ready = useKeel((state) => state.ready);
  const restoreStatus = useKeel((state) => state.restoreStatus);
  const vpnConnecting = useKeel(
    (state) => state.vpn.autoConnect && state.vpn.phase === "connecting",
  );

  // Power-up reopen of existing panes, plus the private tunnel coming up so
  // those panes do not start on the PC's normal route.
  const showRestoring = restoreStatus === "restoring" || vpnConnecting;
  const showFailed = ready && restoreStatus === "failed";

  return (
    <>
      {showRestoring ? (
        <div
          className="pointer-events-none absolute inset-0 z-40 bg-scrim backdrop-blur-[var(--keel-blur)] animate-in fade-in-0 duration-200"
          aria-hidden
        />
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
