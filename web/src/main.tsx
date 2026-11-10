import { setNonce } from "get-nonce";
import { Component, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./index.css";
import { Failure } from "./parts/states.tsx";

/** A fault in a screen's own code: said in words with a way out, never a blank page. */
class Fault extends Component<{ children: ReactNode }, { fault: string }> {
  override state = { fault: "" };
  static getDerivedStateFromError(error: unknown) {
    return { fault: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    if (!this.state.fault) return this.props.children;
    return (
      <main className="mx-auto grid min-h-dvh max-w-sm content-center px-4">
        <Failure
          said={`The dashboard hit a fault of its own: ${this.state.fault}. Reload the page.`}
          again={() => location.reload()}
        />
      </main>
    );
  }
}

// A component that adds a style element at run time gives it control's nonce, which the page's
// Content Security Policy names: the policy allows no other inline style.
const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;
if (nonce) setNonce(nonce);

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fault>
        <App />
      </Fault>
    </StrictMode>,
  );
