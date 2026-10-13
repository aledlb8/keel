import ReactDOM from "react-dom/client";

import App from "./App";
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

// No StrictMode. Its double-invoked effects would spawn every PTY twice and
// rebuild every xterm on mount — the one place in this app where "run the effect
// again to prove it is safe" is actively wrong.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
