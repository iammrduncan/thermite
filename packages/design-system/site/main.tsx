import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { takePageNonce } from "@ds";
import { Site } from "./site.tsx";

// The dialog and the phone's menu add a style at run time: they carry the page's nonce.
takePageNonce();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Site />
    </StrictMode>,
  );
