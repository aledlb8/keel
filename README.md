# Keel

A desktop workspace for running many AI coding agents at once. See [PLAN.md](PLAN.md)
for what it is and where it's going.

Built with Tauri 2, React 19 and Vite.

## Package manager

This project uses **pnpm** exclusively. The version is pinned via the `packageManager`
field in `package.json`, so `corepack enable` will select it automatically.

Do not use `npm` or `yarn` here — their lockfiles are gitignored and a flat
`node_modules` will conflict with pnpm's linked layout.

## Getting set up

```sh
corepack enable    # picks up the pinned pnpm version
pnpm install
pnpm doctor        # verifies Rust, WebView2 and the rest of the toolchain
```

`pnpm doctor` checks everything a full build needs and prints an install hint for
whatever is missing. It exits non-zero if the machine can't build, so it also works
as a CI preflight.

Beyond Node and pnpm you need the [Tauri prerequisites](https://tauri.app/start/prerequisites/):
a Rust toolchain from [rustup](https://rustup.rs), plus the platform's native webview
and C toolchain — Visual Studio Build Tools (C++ workload) and the WebView2 runtime on
Windows, Xcode command line tools on macOS, `libwebkit2gtk-4.1-dev` on Linux.

## Developing

```sh
pnpm dev:app       # the desktop app, with hot reload
pnpm dev           # the frontend alone, in a browser at :1420
```

Use `pnpm dev:app` for normal work. `pnpm dev` is only useful for UI that doesn't call
into Rust — `invoke` fails outside the Tauri shell.

## Building

```sh
pnpm build:app     # release build: the exe plus .msi and .exe installers
pnpm build:exe     # release build, skipping installers — much faster
pnpm build         # frontend bundle only, into dist/
```

Every build writes its shippable output to **`release/`**:

```
release/
  Keel.exe                    the standalone binary
  Keel_0.1.0_x64_en-US.msi    Windows installer (MSI)
  Keel_0.1.0_x64-setup.exe    Windows installer (NSIS, per-user, no admin)
```

`Keel.exe` is self-contained apart from the system WebView2 runtime, so it can be run
or copied directly. The installers are what you hand to someone else.

A cold release build takes several minutes — `[profile.release]` in `src-tauri/Cargo.toml`
turns on LTO and `codegen-units = 1` to keep the binary small. Later builds are much
faster. Reach for `pnpm build:app:debug` when you need a release-shaped bundle with
symbols and the console window attached.

## Using it

Add a folder, and it becomes a project. Terminals open inside it and are listed under
it in the sidebar — fold a project open to see everything running in it, with each
agent's state as a dot: blue while it is working, green once it has finished and you
have not been back to it, grey otherwise. Plain shells are always grey. Click one to focus it on the canvas; if it belongs
to another project, that project comes forward with it. Terminals in projects you are
not looking at keep running.

Selecting a project is one-way: clicking the selected one does not deselect it.

Every row in the sidebar follows one grammar: click goes there, double-click or `F2`
renames it in place, and right-click (or the ⋯ that appears on hover) opens everything
else — add terminals, new deck, reorder, copy the path, show it in Explorer, remove.
Right-click a pane for copy, paste, select all and clear, plus split, fullscreen, move to
another deck, switch profile, restart and close. `F2` in a terminal renames it. The
browser's own context menu is switched off everywhere.

### Decks

A project can hold several arrangements of terminals, all running at once. They are
called decks, and **you will not see any sign of them until you make a second one** —
one deck looks exactly like an app that has never heard of decks.

Once there are two, a numbered rail appears down the edge of the canvas. In the sidebar, a
deck you are not looking at shows a dot when an agent on it is working or has finished. `Alt+Shift+1…9` jumps straight to one.

`Alt+Shift+Space` opens the **overview**: every deck at once, drawn to scale from its
real layout in the agents' colours. Click one to enter it, double-click its name to
rename it, or **drag a terminal from one deck onto another** — the process keeps
running, only the rectangle it is drawn in changes.

The window has no OS decorations — the titlebar is drawn by the app and carries the
menu bar. Each pane has a slim header with its agent,
its profile, and split, fullscreen and close. A pane's edge is a hairline
that brightens when the pane is focused.

Everything the app has to explain lives behind **Project / View / Help** rather than as
text parked next to the terminals.

Keyboard, all on `Alt+Shift` so terminal programs never swallow them:

| Keys | Does |
|---|---|
| `Alt+Shift+←/→/↑/↓` | Move the focused pane to another side |
| `Alt+Shift+F` | Fullscreen the focused pane, and back |
| `Alt+Shift+D` / `Alt+Shift+S` | Split right / split down |
| `Alt+Shift+W` | Close the focused pane |
| `Alt+Shift+E` | Even out every split |
| `Alt+Shift+Tab` | Focus the next pane |
| `Alt+Shift+T` | Add terminals |
| `Alt+Shift+Space` | Overview of every deck |
| `Alt+Shift+Enter` | New deck |
| `Alt+Shift+1…9` | Jump to a deck |

These are handled in the **capture phase**, ahead of xterm. xterm calls
`stopPropagation()` on any chord it turns into an escape sequence, so a normal
listener would never see the arrow keys at all.

**Add terminals** asks how many of each agent you want, previews the exact grid you are
about to get, and can start them in a subdirectory of the project rather than its root.

## Where things are kept

Both files live in the app config directory
(`%APPDATA%\com.alede.keel` on Windows, `~/.config/com.alede.keel` on Linux,
`~/Library/Application Support/com.alede.keel` on macOS):

- `keel.json` — projects, their decks and the layouts on them
- `agents.json` — the agent catalogue

Edit both from **Help › Agents & profiles** (also reachable from the launcher and from
a pane's profile menu). Rename an agent, change its command, badge or colour, hide the
ones you do not use, add your own CLIs, and add, rename or remove sign-in profiles.
Agent changes save as you type.

The catalogue file only stores what differs from the built-in list, so a default that
changes in a later release still reaches every agent you never touched.

Live agent sessions do not survive a restart — layouts do. Reopening a project starts
its shells again and retypes each agent command.

## Checks

```sh
pnpm check         # everything below, in one pass
pnpm typecheck     # tsc --noEmit
pnpm test          # the layout tree, under Node's built-in runner
pnpm rust:lint     # clippy, warnings denied
pnpm rust:fmt      # rustfmt, writes in place
```

`pnpm test` covers `src/lib/tree.ts` and nothing else, on purpose. The tree is the
only pure logic in the app and the only part that fails *quietly* — a bad move
leaves a layout that looks plausible and simply is not what you asked for.

## Housekeeping

```sh
pnpm clean         # drop dist/, release/ and the bundle output
pnpm clean:all     # also drop node_modules/ and src-tauri/target/ — forces a cold rebuild
```

## Releasing a new version

The version lives in three places and they must agree: `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Bump all three, then
`pnpm build:app`.

Builds are unsigned. Windows SmartScreen will warn on first run of the installer until
the binaries are signed with a code-signing certificate.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
