# Keel

## Keep the website in step with the app

The website in `site/` describes what Keel does. When a change adds or alters something a user would notice — a feature, a supported agent, a shortcut, how something looks or behaves — or changes a fact the site states (a count, a limit, a version, an example of what an agent says), update the site in the same piece of work:

- Change the section that covers it, or add one if nothing does (with its link in `site/src/components/Nav.tsx`). Touch the hero when the change alters what Keel is.
- Keep the mock-ups true: what an illustration shows the app doing must be what the app does now.
- Update the feature list in `README.md` and the matching page in `docs/` alongside it.
- Build the site (`pnpm build` in `site/`) and look at the section before calling it done.

If you're not sure a change belongs on the site, say so rather than leaving it out.
