import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cn } from "./utils.ts";

/** The class names, in the order `buttonVariants` emits them. */
function button(variant: string, size: string) {
  return cn("text-sm font-medium", variant, size);
}

describe("cn", () => {
  it("keeps a colour when a named type size follows it", () => {
    // `text-row` is a font size, so it displaces `text-sm` and leaves the
    // variant's colour alone. Reading it as a colour instead is what drew
    // white text on the white primary fill of every small button.
    assert.equal(
      button("bg-primary text-primary-foreground", "h-7 px-2.5 text-row"),
      "font-medium bg-primary text-primary-foreground h-7 px-2.5 text-row",
    );
  });

  it("keeps the colour whichever side the size sits on", () => {
    assert.equal(cn("text-small", "text-dim"), "text-small text-dim");
    assert.equal(cn("text-dim", "text-small"), "text-dim text-small");
  });

  it("still lets one type size replace another", () => {
    for (const size of ["micro", "small", "body", "row", "title", "display"]) {
      assert.equal(cn(`text-${size}`, "text-title"), "text-title");
      assert.equal(cn("text-xs", `text-${size}`), `text-${size}`);
    }
  });

  it("still lets one colour replace another", () => {
    assert.equal(cn("text-dim", "text-foreground"), "text-foreground");
  });
});
