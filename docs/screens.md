# Screens: decks in windows of their own

Keel has one main window and as many more as you have monitors for. Any deck
can go into a window of its own, a *screen*, and sit on any monitor. Every
window shows the same projects; a deck is only ever in one of them, and the
agents in it keep running wherever it goes.

## Opening one

| | |
| --- | --- |
| A deck in its own window | **Open in its own window** in the deck's right-click menu, **View › Open the deck in its own window**, or `Ctrl+Shift+N` for the deck in front. It opens filling the primary monitor. |
| Send a deck to the next monitor | `Ctrl+Alt+Shift+←/→/↑/↓`. If a screen is already on that monitor it shows the deck; if the main window is there the deck goes back to it; otherwise a new window fills that monitor. |
| Go to the window on the next monitor | `Ctrl+Alt+←/→/↑/↓`. Works between two Keel windows side by side on one monitor too. |
| Pop a pane out | **Pop out** in a pane's menu. The pane gets a small window of its own in the corner of the main window, kept above other windows (the pin in its bar turns that off). Closing it puts the pane back on the deck it came from. |
| The agent board | **Go › Agent board**. A small window listing every agent in every project and window, grouped into waiting on you, working and idle. Click one to go to it. It can float too, and comes back where you left it. |

The main window never shows a deck a screen has. When its own deck leaves it
moves to the next deck of the project; when every deck of a project is out, it
says where they went and offers to bring them back. Selecting a deck that is in
another window, from the sidebar, the status bar or `Ctrl+1…9`, brings that
window forward instead.

A screen's bar has the deck's name, a menu to show another deck of the same
project there, the agents waiting on you, a pin to keep it on top, and a button
to send the deck back to the main window. Closing a screen does the same.

## Monitors coming and going

Where every window is, is kept for each set of monitors: their sizes and
positions, not their names, which Windows renumbers. Launching Keel, or
plugging in or unplugging a monitor, puts the windows back the way they were
the last time those monitors were attached. On a set Keel has not seen before,
screens whose monitor is gone fold back into the main window and the rest stay.

## How it works

Rust keeps every pane's terminal: its screen, its scrollback and the modes the
program set, in an `alacritty_terminal` grid, with older history archived as
encoded rows (`src-tauri/src/vt.rs`). The main window starts every pane's
process whether or not anything draws it (`src/lib/supervisor.ts`). A window
that wants to draw a pane attaches to it and is sent a replay of the whole
terminal before any new output; the window that drew it before is sent nothing
more. With no window attached, Rust answers the program's terminal queries
itself.

So a window only holds terminals for what it shows. Each keeps xterms for the
deck on screen and the two shown just before it; every other deck has no xterm,
no scrollback in the webview and no WebGL context, and replays in a few
milliseconds when it comes back.

What the main window needs to know about a pane, that it printed, what its
screen says for agent status, the title and folder its shell reported, and
agent hooks, comes from Rust to the main window whichever window draws it.

The main window holds Keel's state and saves it. A screen's store mirrors it:
the main window sends the parts that changed, and every action taken in a
screen is sent to the main window to run (`src/lib/mirror.ts`). Closing the
main window quits Keel and every screen with it.

The main agent on Telegram can arrange them too: `list_windows` says which
monitor each window is on, and `show_deck` puts a deck on a monitor or back in
the main window.
