/**
 * Power-up reopen chrome.
 *
 * Pending terminals show their own loading status so the saved layout stays
 * visible. Only a failed layout load needs a canvas-wide Retry / Reset panel.
 */

import { Button } from "@/components/ui/button";
import { useKeel } from "@/state/store";

export function RestoreChrome() {
  const ready = useKeel((state) => state.ready);
  const restoreStatus = useKeel((state) => state.restoreStatus);
  const showFailed = ready && restoreStatus === "failed";

  return (
    <>
      {showFailed ? (
        <div className="absolute inset-0 z-40 grid place-items-center bg-scrim backdrop-blur-[var(--keel-blur-strong)]">
          <div className="w-[320px] rounded-[var(--keel-r-window)] border border-line-strong bg-[color:var(--keel-chrome-strong)] px-5 py-5 text-center shadow-[var(--keel-lift-strong)] backdrop-blur-[var(--keel-blur-strong)]">
            <p className="text-title text-foreground">
              Couldn&apos;t restore your layout
            </p>
            <p className="mt-2 text-row leading-relaxed text-dim">
              Last session&apos;s file didn&apos;t load cleanly. Saving is
              paused so it isn&apos;t overwritten. Retry it, or start from an
              empty deck.
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
