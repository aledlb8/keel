# Automatic terminal layout

Normal terminal launches arrange all panes on the active deck together. Existing
panes keep their current reading order, and new panes follow in launch order.
The result depends on the total pane count, so opening six panes together or one
at a time produces the same arrangement. Existing editor panes participate in
the grid and keep their tabs.

`gridRows` chooses at most `ceil(sqrt(count))` columns and the minimum number of
rows needed for that capacity. It divides panes evenly among those rows, giving
one extra pane to each earlier row until the remainder is exhausted. Row lengths
differ by at most one: seven panes become 3–2–2, rather than 3–3–1. Rows have equal
height, and panes within a row have equal width. Every row fills the available
width; there are no empty slots. This takes linear time and space and produces
a layout tree at most two splits deep.

| Panes | Panes per row, top to bottom |
| --- | --- |
| 1 | 1 |
| 2 | 2 |
| 3 | 2, 1 |
| 4 | 2, 2 |
| 5 | 3, 2 |
| 6 | 3, 3 |
| 7 | 3, 2, 2 |
| 8 | 3, 3, 2 |
| 9 | 3, 3, 3 |
| 10 | 4, 3, 3 |

This is a deterministic count-based policy, not an optimization for a particular
monitor aspect ratio or terminal font size. Window resizing retains the chosen
arrangement. Manual resizing and dragging work as before; the next normal launch
rebalances the deck. Explicit directional splits continue to divide only the
chosen pane. Closing panes retains the existing close-and-collapse behavior.

The launch preview and actual layout share `gridRows`. Reflow changes only the
layout tree; pane IDs and existing pane records remain unchanged. The canvas
renders terminals in a flat list keyed by pane ID, so moving their rectangles
does not remount their terminal components or restart their processes. No saved
state format change is required.

## Research

- [kitty's Grid and Splits layouts](https://sw.kovidgoyal.net/kitty/layouts/)
  distinguish automatic balanced grids from explicit directional splitting.
- [tmux's tiled layout implementation](https://github.com/tmux/tmux/blob/master/layout-set.c)
  builds a shallow layout tree of rows and columns from the complete pane count.

Keel uses that established grid approach, with even distribution across
incomplete rows and a shared preview algorithm. It does not copy either
implementation or claim a universally optimal pane shape.

Tests cover launch batching, repeated additions, explicit splits, pane identity,
editor state, deck isolation, ordering, and grid invariants through 128 panes.
