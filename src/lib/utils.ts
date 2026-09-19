import { createCn } from "cn/config"

/**
 * `cn` taught the type scale.
 *
 * The scale in `index.css` names sizes by job — `text-row`, `text-small`,
 * `text-title` — rather than by number, and `cn`'s default tables only know
 * Tailwind's own `text-xs`…`text-9xl`. Anything else after `text-` is assumed
 * to be a colour, so `cn("text-primary-foreground", "text-row")` read the two
 * as the same property and threw the colour away: every `size="sm"` button
 * lost `text-primary-foreground` to the `text-row` that followed it in the
 * variant list, and drew near-white text on its near-white fill.
 *
 * Declaring the six names as font sizes puts them in their own group, so a
 * size and a colour can ride together and only a second *size* displaces one.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["micro", "small", "body", "row", "title", "display"] },
      ],
    },
  },
})
