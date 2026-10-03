/**
 * The dialog behind `ask()`: one question at a time, in Keel's own chrome.
 *
 * Enter goes ahead, Escape or a click outside backs out. Questions asked
 * while one is open wait their turn rather than replacing it.
 */

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { setAsker, type AskOptions } from "@/lib/ask";

interface Question {
  message: string;
  options: AskOptions;
  answer: (yes: boolean) => void;
}

export function AskHost() {
  const [queue, setQueue] = useState<Question[]>([]);
  const go = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setAsker(
      (message, options) =>
        new Promise<boolean>((answer) => {
          setQueue((previous) => [...previous, { message, options, answer }]);
        }),
    );
    return () => setAsker(null);
  }, []);

  const current = queue[0];
  const settle = (yes: boolean) => {
    if (!current) return;
    current.answer(yes);
    setQueue((previous) => previous.slice(1));
  };

  return (
    <Dialog open={Boolean(current)} onOpenChange={(open) => !open && settle(false)}>
      {current ? (
        <DialogContent
          showCloseButton={false}
          className="gap-0 p-0 sm:max-w-[400px]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            go.current?.focus();
          }}
        >
          <div className="flex flex-col gap-2 px-5 pb-4 pt-5">
            <DialogTitle>{current.options.title ?? "Are you sure?"}</DialogTitle>
            <DialogDescription className="select-text text-body leading-relaxed">
              {current.message}
            </DialogDescription>
          </div>
          <div className="flex justify-end gap-1.5 border-t border-line px-4 py-3">
            <Button size="sm" variant="ghost" onClick={() => settle(false)}>
              Cancel
            </Button>
            <Button
              ref={go}
              size="sm"
              variant={current.options.destructive ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {current.options.confirm ?? "Continue"}
            </Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
