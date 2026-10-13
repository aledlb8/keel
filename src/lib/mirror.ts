/**
 * One store, many windows.
 *
 * Only the main window holds Keel's state: it loads it, changes it and saves
 * it. A screen window runs the same store as a mirror — its data is whatever
 * the main window last sent, and every action it calls is sent to the main
 * window to run there. Change something in a screen and it happens once, in
 * the main window, and comes back to every window as state.
 *
 * Data goes out as the keys that changed since the last send, a tick after the
 * change, so a burst of updates is one message. A screen that opens late asks
 * for everything and gets it.
 */

import { emit, emitTo, listen } from "@tauri-apps/api/event";

import { setKeybindingOverrides, type KeybindingOverrides } from "./keymap.ts";
import { MAIN_WINDOW } from "./screens.ts";
import { useKeel, type KeelState } from "../state/store.ts";

/** Open-or-shut UI that belongs to the window it is open in. */
const WINDOW_STATE = new Set<string>(["launcher", "switcher", "menubar"]);
const WINDOW_ACTIONS = new Set<string>(["setLauncher", "setSwitcher", "setMenubar"]);

type Data = Record<string, unknown>;

/** The data in `state`, or only what differs from `since`. */
function dataOf(state: KeelState, since?: KeelState): Data {
  const data: Data = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === "function" || WINDOW_STATE.has(key)) continue;
    if (since && (since as unknown as Data)[key] === value) continue;
    data[key] = value;
  }
  return data;
}

/** In the main window: send state to the screens and run what they ask. */
export function startMirrorHost(): () => void {
  let sent: KeelState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    const state = useKeel.getState();
    if (state.screens.length === 0) {
      // Nobody to tell. The next screen asks for everything anyway.
      sent = null;
      return;
    }
    const data = dataOf(state, sent ?? undefined);
    sent = state;
    if (Object.keys(data).length > 0) void emit("keel:state", data);
  };
  const unsubscribe = useKeel.subscribe(() => {
    timer ??= setTimeout(flush, 0);
  });

  const hello = listen<string>("keel:hello", (event) => {
    void emitTo(event.payload, "keel:state", dataOf(useKeel.getState()));
  });
  const calls = listen<{ name: string; args: unknown[] }>("keel:call", (event) => {
    const { name, args } = event.payload;
    if (WINDOW_ACTIONS.has(name) || !Array.isArray(args)) return;
    const action = (useKeel.getState() as unknown as Data)[name];
    if (typeof action === "function") action(...args);
  });

  return () => {
    unsubscribe();
    clearTimeout(timer);
    void hello.then((stop) => stop());
    void calls.then((stop) => stop());
  };
}

/** In a screen window: take state from the main window and send it actions. */
export function startMirror(label: string): () => void {
  const forwarded: Data = {};
  for (const [name, value] of Object.entries(useKeel.getState())) {
    if (typeof value !== "function" || WINDOW_ACTIONS.has(name)) continue;
    forwarded[name] = (...args: unknown[]) => {
      void emitTo(MAIN_WINDOW, "keel:call", { name, args });
      // The main window answers with state, not a return value.
      return undefined;
    };
  }
  useKeel.setState(forwarded as Partial<KeelState>);

  const state = listen<Data>("keel:state", (event) => {
    const data = event.payload;
    if ("keybindings" in data) {
      setKeybindingOverrides((data.keybindings ?? {}) as KeybindingOverrides);
    }
    useKeel.setState(data as Partial<KeelState>);
  });
  void state.then(() => emitTo(MAIN_WINDOW, "keel:hello", label));

  return () => {
    void state.then((stop) => stop());
  };
}
