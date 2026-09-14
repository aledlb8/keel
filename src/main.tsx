import ReactDOM from "react-dom/client";

import App from "./App";
import "./index.css";

// No StrictMode. Its double-invoked effects would spawn every PTY twice and
// rebuild every xterm on mount — the one place in this app where "run the effect
// again to prove it is safe" is actively wrong.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
