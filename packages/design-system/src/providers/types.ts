export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  supportsToolUse?: boolean;
  supportsVision?: boolean;
}

export interface ProviderFieldDef {
  name: string;
  label: string;
  default?: string;
  hint?: string;
  options?: readonly { value: string; label: string }[];
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  about: string;
  group: "sign-in" | "key" | "cloud" | "local" | "custom" | string;
  connect: "device" | "key" | "url" | "service-account";
  order?: number;
  signIn?: boolean;
  models?: "list" | "typed" | "none";
  modelsDev?: string | readonly string[];
  baseUrl?: string;
  docs?: string;
  start?: string;
  note?: string;
  keyPage?: string;
  steps?: readonly string[];
  hint?: string;
  fields?: readonly ProviderFieldDef[];
  unchecked?: boolean;
  tested?: boolean;
  plugin?: string;
  recommended?: string;
  /** True for local servers that require no API key (e.g. Ollama, LM Studio, llama.cpp). */
  keyless?: boolean;
}

export interface LocalServerInfo {
  kind: string;
  baseUrl: string;
}

export interface DeviceSignInState {
  id: string;
  way: "device" | "redirect" | "paste";
  expiresAt: number;
  url?: string;
  verificationUrl?: string;
  userCode?: string;
}

export interface ProviderConnectPayload {
  kind: string;
  name: string;
  apiKey?: string;
  serviceAccount?: string;
  baseUrl?: string;
  contextWindow?: number | null;
  fields?: Record<string, string>;
  modelIds?: string[];
}
