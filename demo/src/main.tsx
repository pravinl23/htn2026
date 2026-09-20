import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initObservability, watchWalkMoments } from "./observability";
import "./styles.css";

// Sentry first, so an error while the app mounts is still caught. Without VITE_SENTRY_DSN this does nothing.
if (initObservability()) watchWalkMoments(document);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
