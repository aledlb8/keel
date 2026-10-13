import ReactDOM from "react-dom/client";

import { getCurrentWindow } from "@tauri-apps/api/window";

import App from "./App";
import ScreenApp from "./ScreenApp";
import { startMirror } from "./lib/mirror";
import { screenIdOf } from "./lib/screens";
import { useKeel } from "./state/store";
import "./index.css";

function preventOsFileNavigation(event: DragEvent) {
  const types = event.dataTransfer?.types;
  if (!types || !Array.from(types).includes("Files")) return;
  event.preventDefault();
}

window.addEventListener("dragover", preventOsFileNavigation, true);
window.addEventListener("drop", preventOsFileNavigation, true);

// Development builds only: the store, for poking at from devtools.
if (import.meta.env.DEV) {
  (window as unknown as { __keel: typeof useKeel }).__keel = useKeel;
}

// The main window holds Keel's state. Any other window is a screen showing one
// deck, with a store that mirrors the main window's.
const label = getCurrentWindow().label;
const screenId = screenIdOf(label);
if (screenId) startMirror(label);

// No StrictMode. Its double-invoked effects would spawn every PTY twice and
// rebuild every xterm on mount — the one place in this app where "run the effect
// again to prove it is safe" is actively wrong.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  screenId ? <ScreenApp screenId={screenId} /> : <App />,
);
