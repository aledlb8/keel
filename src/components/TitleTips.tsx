/**
 * Every `title` in the app, drawn by us instead of the webview.
 *
 * Nothing opts in. Components keep writing `title="…"` as they always have, and
 * this layer takes the attribute over the first time the pointer reaches it:
 * the text moves to `data-k-tip`, `title` is left empty so the native tooltip
 * never fires, and a tip in the chrome's own colours shows in its place. The
 * empty `title` is what keeps React honest — clearing or changing the prop
 * still writes the attribute, and the observer below picks that up.
 *
 * Text shaped like `withShortcut` output ("Save (Ctrl+S)") gets its chord drawn
 * as keys, and anything after a blank line is set as a quieter second part.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TIP = "kTip";
/** Which aria attribute we filled in when we took the title, so it can follow. */
const ARIA = "kTipAria";

const OPEN_DELAY = 450;
/** Moving to a neighbour within this long of a tip closing skips the delay. */
const SKIP_WINDOW = 350;
const GAP = 6;
const EDGE = 8;

const CHORD = /^([^\n]*\S)\s+\(((?:Ctrl|Alt|Shift|Meta|Cmd|Win|Super)\+[^()\n]+)\)$/;

/** Move a live `title` onto the element's tip, keeping it in the a11y tree. */
function adopt(el: HTMLElement, text: string) {
  el.dataset[TIP] = text;
  el.setAttribute("title", "");
  const named =
    el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
  const aria =
    el.dataset[ARIA] ??
    (named || el.textContent?.trim() ? "aria-description" : "aria-label");
  if (!el.dataset[ARIA] && el.hasAttribute(aria)) return;
  el.dataset[ARIA] = aria;
  el.setAttribute(aria, text);
}

function release(el: HTMLElement) {
  delete el.dataset[TIP];
  const aria = el.dataset[ARIA];
  if (aria) el.removeAttribute(aria);
  delete el.dataset[ARIA];
}

/** The nearest element with something to say, as the webview would pick it. */
function anchorFor(start: EventTarget | null): HTMLElement | null {
  let el = start instanceof Element ? start : null;
  while (el) {
    if (el instanceof HTMLElement) {
      const title = el.getAttribute("title");
      if (title) {
        adopt(el, title);
        return el;
      }
      if (el.dataset[TIP]) return el;
      // An explicit empty title means "nothing here", and stops the search.
      if (title === "") return null;
    }
    el = el.parentElement;
  }
  return null;
}

type Tip = { anchor: HTMLElement; text: string };

export function TitleTips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const tipRef = useRef<Tip | null>(null);
  tipRef.current = tip;

  useEffect(() => {
    let timer: number | undefined;
    let pending: HTMLElement | null = null;
    let lastClosed = 0;

    const show = (anchor: HTMLElement) => {
      const text = anchor.dataset[TIP];
      if (text) setTip({ anchor, text });
    };

    const hide = () => {
      window.clearTimeout(timer);
      pending = null;
      if (tipRef.current) lastClosed = performance.now();
      setTip(null);
    };

    const onOver = (event: PointerEvent) => {
      const anchor = anchorFor(event.target);
      const current = tipRef.current?.anchor ?? pending;
      if (anchor === current) return;
      const open = tipRef.current !== null;
      hide();
      if (!anchor || event.buttons) return;
      if (open || performance.now() - lastClosed < SKIP_WINDOW) {
        show(anchor);
        return;
      }
      pending = anchor;
      timer = window.setTimeout(() => {
        pending = null;
        if (anchor.isConnected) show(anchor);
      }, OPEN_DELAY);
    };

    // Leaving the window entirely never fires a pointerover elsewhere.
    const onOut = (event: PointerEvent) => {
      if (!event.relatedTarget) hide();
    };

    // Titles React sets or changes after we took them over.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target;
        if (!(el instanceof HTMLElement)) continue;
        const title = el.getAttribute("title");
        if (title) {
          adopt(el, title);
          if (tipRef.current?.anchor === el) setTip({ anchor: el, text: title });
        } else if (title === null && el.dataset[TIP] !== undefined) {
          release(el);
          if (tipRef.current?.anchor === el) hide();
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["title"],
    });

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
    };
  }, []);

  // An anchor that unmounts under the pointer takes its tip with it.
  useEffect(() => {
    if (!tip) return;
    const id = window.setInterval(() => {
      if (!tip.anchor.isConnected) setTip(null);
    }, 200);
    return () => window.clearInterval(id);
  }, [tip]);

  return tip ? createPortal(<TipBubble key={tip.text} tip={tip} />, document.body) : null;
}

function TipBubble({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);

  // Above the anchor by default — the cursor sits below the point it rests on —
  // and below when there is no room, clamped inside the window either way.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = tip.anchor.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const above = box.top - GAP - height >= EDGE;
    const top = above ? box.top - GAP - height : box.bottom + GAP;
    const left = Math.min(
      Math.max(box.left + box.width / 2 - width / 2, EDGE),
      window.innerWidth - width - EDGE,
    );
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    el.dataset.side = above ? "top" : "bottom";
    el.dataset.ready = "";
  }, [tip]);

  const [head = "", ...rest] = tip.text.split(/\n\s*\n/);
  const chord = CHORD.exec(head);
  const chordLabel = chord?.[1];
  const chordKeys = chord?.[2];

  return (
    <div ref={ref} role="tooltip" className="k-tip">
      <div className="k-tip-body">
        {chordLabel !== undefined && chordKeys !== undefined ? (
          <>
            <span className="k-tip-head">{chordLabel}</span>
            <span className="k-tip-keys">
              {chordKeys.match(/[^+]+|\+$/g)?.map((key, index) => (
                <kbd key={index}>{key}</kbd>
              ))}
            </span>
          </>
        ) : (
          <span className="k-tip-head">{head}</span>
        )}
      </div>
      {rest.length ? <div className="k-tip-detail">{rest.join("\n\n")}</div> : null}
    </div>
  );
}
