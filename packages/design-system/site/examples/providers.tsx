import {
  DeviceCodePanel,
  ModelCombobox,
  ProviderCatalog,
  type ProviderCatalogEntry,
  ProviderMark,
  type ProviderModel,
} from "@iammrduncan/magnesium/providers";
import { useState } from "react";

const SAMPLE_PROVIDERS: ProviderCatalogEntry[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    about: "Use your OpenAI subscription via device sign-in.",
    group: "sign-in",
    connect: "device",
    signIn: true,
    order: 1,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    about: "Claude models via API key.",
    group: "key",
    connect: "key",
    order: 1,
    keyPage: "https://console.anthropic.com/settings/keys",
    steps: ["Create a key and paste it below."],
  },
  {
    id: "openai",
    name: "OpenAI",
    about: "GPT and o-series models via API key.",
    group: "key",
    connect: "key",
    order: 2,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    about: "One key for hundreds of hosted models.",
    group: "key",
    connect: "key",
    order: 3,
  },
  {
    id: "ollama",
    name: "Ollama",
    about: "Run local models on your workstation or LAN.",
    group: "local",
    connect: "url",
    baseUrl: "http://localhost:11434/v1",
    keyless: true,
    order: 1,
  },
  {
    id: "llama-cpp",
    name: "llama.cpp",
    about: "Local llama-server over HTTP.",
    group: "local",
    connect: "url",
    baseUrl: "http://localhost:8080/v1",
    modelsDev: "llamacpp",
    keyless: true,
    order: 2,
  },
  {
    id: "custom",
    name: "Custom",
    about: "Any OpenAI-compatible HTTPS or LAN HTTP endpoint.",
    group: "custom",
    connect: "url",
    order: 99,
  },
];

const SAMPLE_MODELS: ProviderModel[] = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    supportsToolUse: true,
    supportsVision: true,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 1_000_000,
    supportsToolUse: true,
    supportsVision: true,
  },
  {
    id: "qwen3-32b-q4",
    name: "Qwen3 32B (local)",
    contextWindow: 131_072,
    supportsToolUse: true,
  },
];

export default function ProvidersShowcase() {
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [lastAdded, setLastAdded] = useState("");
  const [expiresAt] = useState(() => Date.now() + 9 * 60 * 1000);

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          {SAMPLE_PROVIDERS.slice(0, 6).map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
              <ProviderMark entry={entry} size={24} />
              <span className="text-xs font-medium">{entry.name}</span>
            </div>
          ))}
        </div>
        <div className="max-w-sm">
          <ModelCombobox
            id="gallery-model"
            models={SAMPLE_MODELS}
            value={model}
            onChange={setModel}
            placeholder="Pick or type a model id"
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <DeviceCodePanel
          providerName="Example Cloud"
          appName="Magnesium"
          signIn={{
            id: "demo-signin",
            way: "device",
            verificationUrl: "https://example.com/device",
            userCode: "MG42-9K7X",
            expiresAt,
          }}
        />
      </div>

      <div className="rounded-xl border bg-card p-4">
        {lastAdded && (
          <p className="mb-3 rounded-md bg-good-tint px-3 py-2 text-xs font-semibold text-good">
            Connected: {lastAdded}
          </p>
        )}
        <ProviderCatalog
          providers={SAMPLE_PROVIDERS}
          localServers={[{ kind: "ollama", baseUrl: "http://localhost:11434/v1" }]}
          appName="Magnesium"
          allowLanHttp
          onConnect={(payload) => {
            setLastAdded(`${payload.name}${payload.baseUrl ? ` (${payload.baseUrl})` : ""}`);
          }}
          renderSignIn={(entry) => (
            <DeviceCodePanel
              providerName={entry.name}
              appName="Magnesium"
              signIn={{
                id: "catalog-demo",
                way: "device",
                verificationUrl: "https://example.com/activate",
                userCode: "AUTH-2026",
                expiresAt,
              }}
            />
          )}
        />
      </div>
    </div>
  );
}
