import { setNonce } from "get-nonce";

/**
 * Gives the page's nonce to the parts that add a style element at run time (the dialog and the
 * sidebar's sheet lock the page's scroll with one). A page served under a Content Security Policy
 * with no inline style carries the nonce in a meta element, which Vite writes (`html.cspNonce`);
 * the policy allows no other inline style. An app calls this once, before it draws.
 */
export function takePageNonce(): void {
  const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;
  if (nonce) setNonce(nonce);
}
