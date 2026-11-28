import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { applyPreset, initialPreset } from "./preset.ts";
import { Site } from "./site.tsx";

applyPreset(initialPreset());

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Site />
    </StrictMode>,
  );
}
