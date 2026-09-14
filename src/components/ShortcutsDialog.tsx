/**
 * The keyboard reference, on demand.
 *
 * This used to be a line of grey text pinned above the terminals. It reads once
 * and then costs a row of pixels forever, which is exactly the kind of text this
 * app should not have on screen.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SHORTCUTS } from "@/lib/keymap";

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            All on Alt+Shift, so nothing collides with what the agent in a pane
            is listening for.
          </DialogDescription>
        </DialogHeader>

        <dl className="divide-y divide-line">
          {SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.code}
              className="flex items-center justify-between gap-4 py-2"
            >
              <dt className="text-[13px] text-dim">{shortcut.label}</dt>
              <dd className="shrink-0 rounded-[var(--keel-r-chip)] bg-veil-2 px-2 py-1 font-mono text-[11px] text-foreground">
                {shortcut.keys}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
