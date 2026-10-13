/**
 * What the main window shows for a project whose every deck is in a window of
 * its own: where they went, and the way back.
 */

import { AppWindow, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Project } from "@/lib/types";
import { useKeel } from "@/state/store";

export function DecksAway({ project }: { project: Project }) {
  const keel = useKeel.getState;
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="w-[360px] text-center">
        <AppWindow aria-hidden className="mx-auto size-5 text-faint" />
        <p className="mt-3 text-title text-foreground">
          {project.decks.length === 1
            ? `${project.name}'s deck is in its own window`
            : `Every deck of ${project.name} is in its own window`}
        </p>
        <ul className="mt-4 flex flex-col gap-1.5 text-left">
          {project.decks.map((deck) => (
            <li
              key={deck.id}
              className="flex items-center gap-2 rounded-control border border-line px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-row text-foreground">{deck.name}</span>
              <button
                type="button"
                className="k-tag"
                onClick={() => keel().selectDeck(project.id, deck.id)}
              >
                Go there
              </button>
              <button
                type="button"
                className="k-tag"
                onClick={() => keel().bringDeckHome(deck.id)}
              >
                Bring back
              </button>
            </li>
          ))}
        </ul>
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => keel().addDeck(project.id)}
        >
          <Plus className="size-4" />
          New deck here
        </Button>
      </div>
    </div>
  );
}
