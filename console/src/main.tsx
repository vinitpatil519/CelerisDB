import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ConnectionProvider } from "./connection";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectionProvider>
      <App />
    </ConnectionProvider>
  </StrictMode>,
);
