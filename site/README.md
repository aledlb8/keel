# Keel website

The one-page site for Keel, built with Next.js and Tailwind CSS.

```sh
pnpm install
pnpm dev     # http://localhost:3000
pnpm build   # static export-ready production build
```

The hero holds a working replica of the Keel workspace (`src/components/demo`):
agents run scripted turns, finish into the island, and respond to `F8`,
`Ctrl+O` and the launch dialog. The simulation pauses while it is off screen.

A crew of mini Claudes (`src/components/crew`) builds the page as you read it:
one sets each section heading letter by letter and hammers in the full stop,
one rappels onto the headline, one bolts the demo window flat while another
climbs up to watch, one paints the agent names, one presses the shortcuts, and
the rest knock off on the footer. They only move while on screen, and with
reduced motion they are already sitting where they finish.
