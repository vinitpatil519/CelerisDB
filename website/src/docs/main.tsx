import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles/site.css";
import "./docs.css";
import { DocsApp } from "./DocsApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DocsApp />
  </StrictMode>,
);