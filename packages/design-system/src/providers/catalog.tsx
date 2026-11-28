import { ArrowLeftIcon, ExternalLinkIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Input } from "../primitives/input.tsx";
import { NativeSelect, NativeSelectOption } from "../primitives/native-select.tsx";
import { ProviderMark } from "./mark.tsx";
import type { LocalServerInfo, ProviderCatalogEntry, ProviderConnectPayload } from "./types.ts";

const LABEL_CLASS = "grid gap-1.5 text-sm font-medium";
const HINT_CLASS = "font-normal text-muted-foreground";
const LINK_CLASS = "inline-flex items-center gap-1 font-medium underline underline-offset-4";

const byOrder = (a: ProviderCatalogEntry, b: ProviderCatalogEntry) =>
  (a.order ?? 0) - (b.order ?? 0);

const listOf = (value: string) =>
  value
    .split(/[\n,]/)
    .map((id) => id.trim())
    .filter(Boolean);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface ProviderCatalogWords {
  signIn?: string;
  key?: string;
  local?: string;
}

const GROUPS = [
  ["key", "Use a key", "key"],
  ["cloud", "Clouds", ""],
  ["local", "On your machine or LAN", "local"],
] as const;

/**
 * API-agnostic, callback-driven provider catalog and connection workflow.
 * Supports sign-in, API key, cloud service-account, and LAN/localhost HTTP endpoints out of the box.
 */
export function ProviderCatalog({
  providers,
  more = [],
  localServers = [],
  loading = false,
  error = "",
  onRetry,
  words,
  chatOnly = false,
  allowLanHttp = true,
  appName = "this app",
  docsBaseUrl = "",
  onPick,
  onConnect,
  renderSignIn,
}: {
  providers: readonly ProviderCatalogEntry[] | null;
  more?: readonly ProviderCatalogEntry[];
  localServers?: readonly LocalServerInfo[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  words?: ProviderCatalogWords;
  chatOnly?: boolean;
  /** When true, local/custom URL hints explicitly allow plain HTTP LAN endpoints. */
  allowLanHttp?: boolean;
  appName?: string;
  docsBaseUrl?: string;
  /** Optional hook when a provider tile is clicked (bypassing the built-in connect card if omitted). */
  onPick?: (entry: ProviderCatalogEntry) => void;
  /** Callback submitted by the built-in `ProviderConnectCard`. */
  onConnect?: (
    payload: ProviderConnectPayload,
    entry: ProviderCatalogEntry,
  ) => void | Promise<void>;
  /** Custom sign-in panel renderer (e.g. `DeviceCodePanel`) for entries with `entry.signIn`. */
  renderSignIn?: (entry: ProviderCatalogEntry) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ProviderCatalogEntry | null>(null);

  if (picked) {
    const found = localServers.find((server) => server.kind === picked.id);
    const fromTail = more.some((e) => e.id === picked.id);
    return (
      <ProviderConnectCard
        entry={picked}
        fromTail={fromTail}
        found={found}
        allowLanHttp={allowLanHttp}
        appName={appName}
        docsBaseUrl={docsBaseUrl}
        onBack={() => setPicked(null)}
        onConnect={onConnect}
        signInSlot={picked.signIn ? renderSignIn?.(picked) : undefined}
      />
    );
  }

  if (loading || !providers) {
    return error ? (
      <div className="grid gap-2">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        {onRetry && (
          <Button type="button" variant="outline" className="justify-self-start" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" /> Loading providers
      </p>
    );
  }

  const shown = providers.filter((e) => e.order !== undefined && !e.plugin);
  const brought = chatOnly
    ? []
    : [...new Set(providers.flatMap((e) => (e.plugin ? [e.plugin] : [])))];
  const signIns = [
    ...shown.filter((e) => e.group === "sign-in").sort(byOrder),
    ...shown.filter((e) => e.group !== "sign-in" && e.signIn).sort(byOrder),
  ];
  const custom = providers.find((e) => e.group === "custom");
  const q = query.trim().toLowerCase();
  const matches = (e: ProviderCatalogEntry) =>
    e.name.toLowerCase().includes(q) ||
    e.id.toLowerCase().includes(q) ||
    e.about.toLowerCase().includes(q);
  const results = q
    ? [
        ...providers.filter((e) => matches(e) && !(chatOnly && e.models === "none")),
        ...more.filter(matches),
      ]
    : [];

  function choose(entry: ProviderCatalogEntry) {
    if (onPick && !onConnect) {
      onPick(entry);
      return;
    }
    onPick?.(entry);
    setPicked(entry);
  }

  const tile = (e: ProviderCatalogEntry) => (
    <ProviderTile
      key={`${e.group}-${e.id}`}
      entry={e}
      found={localServers.some((server) => server.kind === e.id)}
      onPick={() => choose(e)}
    />
  );

  return (
    <div className="grid gap-5">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          aria-label="Search providers"
          placeholder="Search providers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {q ? (
        <ProviderGroup
          title={results.length ? `${results.length} found` : "No provider by that name"}
          about={
            results.length
              ? undefined
              : "Custom connects to any OpenAI-compatible server over HTTPS or LAN HTTP."
          }
        >
          {results.map(tile)}
          {!results.length && custom && tile(custom)}
        </ProviderGroup>
      ) : (
        <>
          {(signIns.length > 0 || custom) && (
            <ProviderGroup
              title="Sign in"
              about={words?.signIn ?? "With an account you already have. Nothing to paste."}
            >
              {signIns.map((e) => (
                <ProviderTile key={`s-${e.id}`} entry={e} onPick={() => choose(e)} />
              ))}
              {custom && <ProviderTile entry={custom} onPick={() => choose(custom)} />}
            </ProviderGroup>
          )}
          {GROUPS.map(([group, title, worded]) => {
            const entries = shown.filter((e) => e.group === group).sort(byOrder);
            if (entries.length === 0) return null;
            return (
              <ProviderGroup key={group} title={title} about={worded ? words?.[worded] : undefined}>
                {entries.map(tile)}
              </ProviderGroup>
            );
          })}
          {brought.map((plugin) => (
            <ProviderGroup
              key={`plugin-${plugin}`}
              title={`For ${plugin}`}
              about={`Used by the ${plugin} plugin.`}
            >
              {providers
                .filter((e) => e.plugin === plugin)
                .sort(byOrder)
                .map(tile)}
            </ProviderGroup>
          ))}
        </>
      )}
    </div>
  );
}

function ProviderGroup({
  title,
  about,
  children,
}: {
  title: string;
  about?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {about && <p className="-mt-1 text-sm text-muted-foreground">{about}</p>}
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function ProviderTile({
  entry,
  found,
  onPick,
}: {
  entry: ProviderCatalogEntry;
  found?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex min-w-0 items-center gap-3 rounded-xl border p-2.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ProviderMark entry={entry} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-medium">{entry.name}</span>
          {found && <span className="shrink-0 text-xs text-brand-accent">Found here</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{entry.about}</span>
      </span>
    </button>
  );
}

/** Provider connection form card supporting API keys, service accounts, custom/LAN URLs, and OAuth slots. */
export function ProviderConnectCard({
  entry,
  fromTail = false,
  found,
  allowLanHttp = true,
  appName = "this app",
  docsBaseUrl = "",
  signInSlot,
  onBack,
  onConnect,
}: {
  entry: ProviderCatalogEntry;
  fromTail?: boolean;
  found?: LocalServerInfo;
  allowLanHttp?: boolean;
  appName?: string;
  docsBaseUrl?: string;
  signInSlot?: ReactNode;
  onBack?: () => void;
  onConnect?: (
    payload: ProviderConnectPayload,
    entry: ProviderCatalogEntry,
  ) => void | Promise<void>;
}) {
  const isUrl = entry.connect === "url";
  const isFile = entry.connect === "service-account";
  const isTyped = entry.models === "typed" || entry.id === "custom";
  const isKeyless =
    entry.keyless ??
    (entry.id === "ollama" ||
      entry.id === "lmstudio" ||
      entry.id === "llama-cpp" ||
      entry.id === "llamacpp");

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(found?.baseUrl ?? entry.baseUrl ?? "");
  const [fields, setFields] = useState<Record<string, string>>(() =>
    Object.fromEntries((entry.fields ?? []).map((f) => [f.name, f.default ?? ""])),
  );
  const [apiKey, setApiKey] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const helpUrl = entry.docs
    ? entry.docs.startsWith("/") && docsBaseUrl
      ? `${docsBaseUrl}${entry.docs}`
      : entry.docs
    : "";
  const steps = [...(entry.keyPage ? [null] : []), ...(entry.steps ?? [])];

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!onConnect) return;
    setBusy(true);
    setError("");
    try {
      await onConnect(
        {
          kind: entry.id,
          name: name.trim() || entry.name,
          ...(isFile ? { serviceAccount } : isKeyless ? {} : { apiKey }),
          ...(entry.fields?.length ? { fields } : {}),
          ...(isTyped ? { modelIds: listOf(modelIds) } : {}),
          ...(isUrl
            ? { baseUrl: baseUrl.trim(), contextWindow: context ? Number(context) : null }
            : {}),
        },
        entry,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 justify-self-start text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" /> All providers
        </button>
      )}
      <div className="flex items-center gap-3">
        <ProviderMark entry={entry} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{entry.name}</h3>
          <p className="text-sm text-muted-foreground">{entry.about}</p>
        </div>
      </div>
      {(entry.start || helpUrl) && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {entry.start && <span className="rounded-md bg-muted px-2 py-0.5">{entry.start}</span>}
          {helpUrl && (
            <a className={LINK_CLASS} href={helpUrl} target="_blank" rel="noreferrer">
              Help <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
        </p>
      )}
      {fromTail && entry.baseUrl && (
        <p className="text-sm text-muted-foreground">
          {entry.tested ? "" : `Not yet verified with ${appName}. `}Listed as an OpenAI-compatible
          API at <code className="break-all">{entry.baseUrl}</code>.
        </p>
      )}
      {entry.note && <p className="text-sm text-muted-foreground">{entry.note}</p>}
      {signInSlot}
      {signInSlot && entry.connect !== "device" && (
        <p className="text-sm font-medium">Or use a key</p>
      )}
      {entry.connect !== "device" && (
        <form onSubmit={(e) => void handleSubmit(e)} className="grid gap-4">
          {steps.length > 0 && (
            <ol className="grid list-decimal gap-1 pl-5 text-sm">
              {steps.map((step, i) =>
                step === null && entry.keyPage ? (
                  <li key="page">
                    <a className={LINK_CLASS} href={entry.keyPage} target="_blank" rel="noreferrer">
                      Open {hostOf(entry.keyPage)} <ExternalLinkIcon className="size-3.5" />
                    </a>
                  </li>
                ) : (
                  <li key={step ?? i}>{step}</li>
                ),
              )}
            </ol>
          )}
          {entry.fields?.map((f) => {
            const fieldId = `provider-field-${entry.id}-${f.name}`;
            return (
              <div key={f.name} className={LABEL_CLASS}>
                <label htmlFor={fieldId}>{f.label}</label>
                {f.options ? (
                  <NativeSelect
                    id={fieldId}
                    className="w-full"
                    value={fields[f.name] ?? ""}
                    onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
                  >
                    {f.options.map((o) => (
                      <NativeSelectOption key={o.value} value={o.value}>
                        {o.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    id={fieldId}
                    required
                    value={fields[f.name] ?? ""}
                    onChange={(e) => setFields({ ...fields, [f.name]: e.target.value.trim() })}
                  />
                )}
                {f.hint && <span className={HINT_CLASS}>{f.hint}</span>}
              </div>
            );
          })}
          {isUrl && (
            <label className={LABEL_CLASS}>
              Address
              <Input
                required
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={allowLanHttp ? "http://localhost:8080/v1" : "https://host/v1"}
              />
              <span className={HINT_CLASS}>
                {found ? "Found running locally. " : ""}
                {entry.hint ??
                  (allowLanHttp
                    ? "An OpenAI-compatible API including /v1. HTTPS, localhost, or LAN HTTP endpoints are supported."
                    : "An OpenAI-compatible API including /v1. HTTPS, or HTTP on localhost.")}
              </span>
            </label>
          )}
          {isFile ? (
            <label className={LABEL_CLASS}>
              Service account key
              <Input
                type="file"
                accept="application/json,.json"
                required
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  if (chosen) void chosen.text().then(setServiceAccount);
                }}
              />
              <span className={HINT_CLASS}>
                The downloaded JSON file is sent once, sealed on the server, and never returned.
              </span>
            </label>
          ) : (
            !isKeyless && (
              <label className={LABEL_CLASS}>
                {isUrl ? "API key (optional for local servers)" : "API key"}
                <Input
                  type="password"
                  autoComplete="off"
                  required={!isUrl}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <span className={HINT_CLASS}>
                  Sent once, sealed on the server, and never returned to this browser.
                </span>
              </label>
            )
          )}
          {isTyped && (
            <label className={LABEL_CLASS}>
              {entry.id === "custom" ? "Model ids (if the server lists none)" : "Deployments"}
              <Input
                required={entry.id !== "custom"}
                value={modelIds}
                onChange={(e) => setModelIds(e.target.value)}
                placeholder="One or more, separated by commas"
              />
            </label>
          )}
          {isUrl && (
            <label className={LABEL_CLASS}>
              Context window
              <Input
                inputMode="numeric"
                value={context}
                onChange={(e) => setContext(e.target.value.replace(/\D/g, ""))}
                placeholder="As the server reports"
              />
            </label>
          )}
          <label className={LABEL_CLASS}>
            Name
            <Input
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={entry.name}
            />
          </label>
          {entry.unchecked && (
            <p className="text-sm text-muted-foreground">
              {entry.name} accepts any key when listing models, so {appName} verifies credentials on
              the first request.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="justify-self-start"
            disabled={busy || (isFile && !serviceAccount)}
          >
            {busy ? "Checking…" : "Add"}
          </Button>
        </form>
      )}
    </div>
  );
}
