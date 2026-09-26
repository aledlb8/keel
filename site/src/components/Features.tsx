import { Container, Heading } from "./ui";

const FEATURES = [
  {
    title: "Decks keep running",
    body: "Split a project into decks of panes. Switch away and every process keeps going. The overview shows all of them at once and lets you move a running terminal to another deck.",
  },
  {
    title: "It comes back as you left it",
    body: "Projects, layouts, terminals and resumable agent conversations return after a restart. Keel saves each conversation's real ID the moment the agent reports it, and resumes that one.",
  },
  {
    title: "It knows when an agent is done",
    body: "Lifecycle hooks report when a turn starts and ends. A finished agent chimes unless its own pane has focus, even from another deck, project or dialog. Mute notifications per pane.",
  },
  {
    title: "Editor, search and Git in reach",
    body: "Open files in the built-in editor, search the whole project, and review diffs. Stage, commit, fetch, pull, push and switch branches without leaving the deck.",
  },
  {
    title: "Quota where you can see it",
    body: "Subscription usage for each signed-in agent sits in the status bar: a small ring per login, amber from 75% and red from 90%.",
  },
  {
    title: "It steps back when you do",
    body: "The window fades while it is out of focus, enough to see what is behind it, never so much that running agents become unreadable. Click into the demo above, then move off it.",
  },
  {
    title: "Your CLIs, your accounts",
    body: "Keel launches the agent CLIs already installed on your machine. No hosted service sits in between, and nothing about your credentials leaves the tools that manage them.",
  },
  {
    title: "A private tunnel on Windows",
    body: "Optionally route Keel's traffic through an isolated OpenVPN tunnel without replacing your machine's default route.",
  },
];

export function Features() {
  return (
    <section id="features" className="relative py-24 sm:py-36">
      <Container>
        <div className="grid gap-14 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="lg:sticky lg:top-32">
              <Heading>Built for a long day of parallel work.</Heading>
              <p className="mt-8 max-w-[26rem] text-[18px] leading-[1.65] text-dim">
                A native app built on Tauri and Rust, so a dozen terminals cost
                what terminals cost.
              </p>
            </div>
          </div>
          <ul className="lg:col-span-7">
            {FEATURES.map((f) => (
              <li
                key={f.title}
                className="group grid gap-3 border-t border-white/[0.07] py-9 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-10"
              >
                <h3 className="text-[22px] leading-[1.2] font-[700] tracking-[-0.015em] [font-stretch:108%]">
                  {f.title}
                </h3>
                <p className="text-[16px] leading-[1.65] text-dim transition-colors duration-300 group-hover:text-ink/85">
                  {f.body}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  );
}
