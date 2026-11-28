import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import qrcode from "qrcode-generator";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils.ts";
import { copyText } from "../parts/copy-id.tsx";
import { Button } from "../primitives/button.tsx";
import { Input } from "../primitives/input.tsx";
import type { DeviceSignInState } from "./types.ts";

const LINK_CLASS = "inline-flex items-center gap-1 font-medium underline underline-offset-4";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Renders a crisp monochrome SVG QR code backed by the optional `qrcode-generator` peer.
 */
export function QrCode({
  text,
  label = "QR code",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const path = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(text);
    code.make();
    const n = code.getModuleCount();
    let d = "";
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (code.isDark(row, col)) d += `M${col + 2} ${row + 2}h1v1h-1z`;
      }
    }
    return { d, size: n + 4 };
  }, [text]);

  return (
    <svg
      viewBox={`0 0 ${path.size} ${path.size}`}
      className={cn("size-36 rounded-md bg-white p-1", className)}
      role="img"
      aria-label={label}
    >
      <path d={path.d} fill="#000" />
    </svg>
  );
}

function CopyAction({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : `Copy ${what}`}
    </Button>
  );
}

/**
 * API-agnostic OAuth / device-code sign-in panel supporting device-code (with QR code & plain-HTTP
 * clipboard copy), redirect, and manual paste flows.
 */
export function DeviceCodePanel({
  providerName,
  appName = "this app",
  signIn,
  started = true,
  loading = false,
  error = "",
  onStart,
  onRetry,
  onSwitchToPaste,
  onSubmitCode,
}: {
  providerName: string;
  appName?: string;
  signIn: DeviceSignInState | null;
  started?: boolean;
  loading?: boolean;
  error?: string;
  onStart?: () => void;
  onRetry?: () => void;
  onSwitchToPaste?: () => void;
  onSubmitCode?: (code: string) => void | Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!signIn) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [signIn]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!onSubmitCode || !code.trim()) return;
    setSubmitting(true);
    try {
      await onSubmitCode(code.trim());
    } finally {
      setSubmitting(false);
    }
  }

  if (!started) {
    return (
      <Button type="button" className="justify-self-start" onClick={onStart}>
        Sign in with {providerName}
      </Button>
    );
  }

  if (error) {
    return (
      <div className="grid gap-2">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        {onRetry && (
          <Button type="button" variant="outline" className="justify-self-start" onClick={onRetry}>
            Start again
          </Button>
        )}
      </div>
    );
  }

  if (loading || !signIn) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" /> Starting the sign-in…
      </p>
    );
  }

  const left = Math.max(0, Math.round((signIn.expiresAt - now) / 1000));
  if (left === 0) {
    return (
      <div className="grid gap-2">
        <p className="text-sm">This sign-in expired.</p>
        {onRetry && (
          <Button type="button" variant="outline" className="justify-self-start" onClick={onRetry}>
            Start again
          </Button>
        )}
      </div>
    );
  }

  const waiting = (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" /> Waiting for you to sign in ·{" "}
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left
    </p>
  );

  if (signIn.way === "redirect" && signIn.url) {
    return (
      <div className="grid gap-3">
        <Button asChild className="justify-self-start">
          <a href={signIn.url} target="_blank" rel="noopener">
            Continue to {providerName} <ExternalLinkIcon />
          </a>
        </Button>
        <p className="text-sm text-muted-foreground">
          It opens in a new tab and returns to {appName} when approved. This page finishes on its
          own.
        </p>
        {waiting}
        {onSwitchToPaste && (
          <button
            type="button"
            className="justify-self-start text-sm text-muted-foreground underline underline-offset-4"
            onClick={onSwitchToPaste}
          >
            Didn't come back? Use a code instead
          </button>
        )}
      </div>
    );
  }

  if (signIn.way === "paste" && signIn.url) {
    return (
      <form onSubmit={(e) => void handleSubmit(e)} className="grid gap-3">
        <ol className="grid list-decimal gap-1 pl-5 text-sm">
          <li>
            <a className={LINK_CLASS} href={signIn.url} target="_blank" rel="noopener">
              Open {providerName}'s sign-in <ExternalLinkIcon className="size-3.5" />
            </a>
            , and approve {appName}.
          </li>
          <li>Copy the code it shows and paste it here.</li>
        </ol>
        <Input
          aria-label="Code"
          autoComplete="off"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="The code"
        />
        <Button type="submit" className="justify-self-start" disabled={submitting}>
          {submitting ? "Checking…" : "Finish"}
        </Button>
        {waiting}
      </form>
    );
  }

  const verificationUrl = signIn.verificationUrl ?? signIn.url ?? "";
  const userCode = signIn.userCode ?? "";
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Open the link on any device, sign in, and enter this code. This page finishes on its own.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        {verificationUrl && (
          <QrCode text={verificationUrl} label={`QR code for ${providerName} sign-in link`} />
        )}
        <div className="grid gap-2">
          {userCode && (
            <code
              title="Sign-in code"
              className="justify-self-start rounded-lg bg-muted px-3 py-1.5 font-mono text-2xl tracking-widest"
            >
              <span className="sr-only">Sign-in code: </span>
              {userCode}
            </code>
          )}
          <div className="flex flex-wrap gap-2">
            {userCode && <CopyAction text={userCode} what="code" />}
            {verificationUrl && <CopyAction text={verificationUrl} what="link" />}
          </div>
          {verificationUrl && (
            <a className={LINK_CLASS} href={verificationUrl} target="_blank" rel="noopener">
              Open {hostOf(verificationUrl)} <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      {waiting}
    </div>
  );
}
