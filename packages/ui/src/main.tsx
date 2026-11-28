import { takePageNonce } from "@iammrduncan/magnesium/lib/nonce";
import { Alone, Failure } from "@iammrduncan/magnesium/parts";
import { Component, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

class Fault extends Component<{ children: ReactNode }, { fault: string }> {
  override state = { fault: "" };

  static getDerivedStateFromError(error: unknown) {
    return { fault: error instanceof Error ? error.message : String(error) };
  }

  override render() {
    if (!this.state.fault) return this.props.children;
    return (
      <Alone>
        <Failure
          said={`The dashboard hit an error: ${this.state.fault}. Reload the page.`}
          again={() => location.reload()}
        />
      </Alone>
    );
  }
}

takePageNonce();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Fault>
        <App />
      </Fault>
    </StrictMode>,
  );
}
