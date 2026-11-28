export const ERROR_HTTP_STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ThermiteErrorCode = keyof typeof ERROR_HTTP_STATUS;
export type ThermiteErrorJson = {
  readonly code: ThermiteErrorCode;
  readonly message: string;
  readonly status: number;
  readonly details?: unknown;
};
export const isThermiteErrorCode = (v: unknown): v is ThermiteErrorCode =>
  typeof v === "string" && Object.hasOwn(ERROR_HTTP_STATUS, v);
export class ThermiteError extends Error {
  override readonly name = "ThermiteError";
  readonly code: ThermiteErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ThermiteErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    if (details !== undefined) this.details = details;
  }
  toJSON(): ThermiteErrorJson {
    const base = { code: this.code, message: this.message, status: this.status };
    return this.details !== undefined ? { ...base, details: this.details } : base;
  }
}
export const isThermiteError = (err: unknown): err is ThermiteError => err instanceof ThermiteError;
