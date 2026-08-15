// Icon fonts are bundled, never fetched: the UI has to render in an air-gapped
// network, behind a corporate proxy, or under a CSP that forbids third-party
// styles. Only the weights actually used are imported.
import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/bold";
import "@phosphor-icons/web/fill";
import "@phosphor-icons/web/duotone";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
