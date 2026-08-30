import type { JsonWebKey } from "node:crypto";
import { PrismError, type Principal } from "@prismengine/contracts-data";
import type { HttpPrincipalProvider, HttpPrincipalRequest } from "./configuration.js";

interface JwtHeader {
  readonly alg: "RS256";
  readonly kid: string;
}

interface JwtClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly name?: string;
  readonly [claim: string]: unknown;
}

export interface OidcPrincipalProviderOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly rolesClaim?: string;
  readonly permissionsClaim?: string;
  readonly displayNameClaim?: string;
  readonly clockSkewSeconds?: number;
  readonly jwksCacheMs?: number;
  readonly jwksFetchTimeoutMs?: number;
  readonly jwksRefreshCooldownMs?: number;
  readonly jwksMaxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

interface CachedKeySet {
  readonly expiresAt: number;
  readonly keys: readonly JsonWebKey[];
}

/**
 * Creates a host-owned OIDC/JWKS identity boundary. Only RS256 is accepted;
 * unsigned tokens, algorithm substitution and browser role headers are denied.
 */
export function createOidcPrincipalProvider(
  options: OidcPrincipalProviderOptions,
): HttpPrincipalProvider {
  const issuer = options.issuer.replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const skew = options.clockSkewSeconds ?? 30;
  const cacheMs = options.jwksCacheMs ?? 300_000;
  const fetchTimeoutMs = positiveMilliseconds(
    options.jwksFetchTimeoutMs,
    5_000,
    "jwksFetchTimeoutMs",
  );
  const refreshCooldownMs = positiveMilliseconds(
    options.jwksRefreshCooldownMs,
    30_000,
    "jwksRefreshCooldownMs",
  );
  const maxResponseBytes = positiveSafeInteger(
    options.jwksMaxResponseBytes,
    1_048_576,
    "jwksMaxResponseBytes",
  );
  let cached: CachedKeySet | undefined;
  let loading: Promise<CachedKeySet> | undefined;
  let lastForcedRefreshAt: number | undefined;

  const load = async (force: boolean): Promise<CachedKeySet> => {
    if (!force && cached !== undefined && cached.expiresAt > now()) return cached;
    if (loading !== undefined) return loading;

    const pending = loadKeys(
      fetcher,
      options.jwksUri,
      fetchTimeoutMs,
      maxResponseBytes,
    ).then((keys) => ({
      keys,
      expiresAt: now() + cacheMs,
    }));
    loading = pending;
    try {
      const loaded = await pending;
      cached = loaded;
      return loaded;
    } finally {
      if (loading === pending) loading = undefined;
    }
  };

  const forcedRefresh = async (): Promise<CachedKeySet | null> => {
    if (loading !== undefined) return loading;
    const refreshAt = now();
    if (
      lastForcedRefreshAt !== undefined &&
      refreshAt - lastForcedRefreshAt < refreshCooldownMs
    ) {
      return null;
    }
    lastForcedRefreshAt = refreshAt;
    return load(true);
  };

  return async (request: HttpPrincipalRequest): Promise<Principal | null> => {
    const authorization = firstHeader(request.headers.authorization);
    if (authorization === undefined || !authorization.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length).trim();
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (!encodedHeader || !encodedClaims || !encodedSignature) return null;

    const header = parseHeader(encodedHeader);
    const claims = parseClaims(encodedClaims);
    if (header === null || claims === null) return null;
    if (header.alg !== "RS256" || claims.iss.replace(/\/$/, "") !== issuer) return null;
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    if (!audiences.includes(options.audience)) return null;
    const epochSeconds = Math.floor(now() / 1_000);
    if (
      claims.exp < epochSeconds - skew ||
      (claims.nbf !== undefined && claims.nbf > epochSeconds + skew)
    ) {
      return null;
    }

    const warmCache = cached !== undefined && cached.expiresAt > now();
    const initial = await load(false);
    let verified = await verifySignature(
      initial.keys,
      header.kid,
      encodedHeader,
      encodedClaims,
      encodedSignature,
    );
    if (!verified && warmCache) {
      const refreshed = await forcedRefresh();
      if (refreshed !== null) {
        verified = await verifySignature(
          refreshed.keys,
          header.kid,
          encodedHeader,
          encodedClaims,
          encodedSignature,
        );
      }
    }
    if (!verified) return null;

    const roles = stringList(claims[options.rolesClaim ?? "roles"]).filter(
      (role) => role !== "system",
    );
    const permissions = stringList(claims[options.permissionsClaim ?? "permissions"]);
    const displayNameValue = claims[options.displayNameClaim ?? "name"];
    return {
      id: claims.sub,
      ...(typeof displayNameValue === "string" && displayNameValue.length > 0
        ? { displayName: displayNameValue }
        : {}),
      roles,
      permissions,
    };
  };
}

async function loadKeys(
  fetcher: typeof globalThis.fetch,
  jwksUri: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<readonly JsonWebKey[]> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        PrismError.of(
          "AUTHENTICATION_PROVIDER_UNAVAILABLE",
          "OIDC signing keys are unavailable.",
          { timeoutMs },
        ),
      );
    }, timeoutMs);
  });
  const operation = (async (): Promise<readonly JsonWebKey[]> => {
    let response: Response;
    try {
      response = await fetcher(jwksUri, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      throw PrismError.of(
        "AUTHENTICATION_PROVIDER_UNAVAILABLE",
        "OIDC signing keys are unavailable.",
      );
    }
    if (!response.ok) {
      throw PrismError.of(
        "AUTHENTICATION_PROVIDER_UNAVAILABLE",
        "OIDC signing keys are unavailable.",
        { status: response.status },
      );
    }

    const value = await readJwksJson(response, maxResponseBytes);
    if (
      typeof value !== "object" ||
      value === null ||
      !("keys" in value) ||
      !Array.isArray(value.keys) ||
      !value.keys.every(isObject)
    ) {
      throw PrismError.of(
        "AUTHENTICATION_PROVIDER_INVALID",
        "OIDC JWKS response is malformed.",
      );
    }
    return value.keys.filter(isSigningJsonWebKey);
  })();

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function readJwksJson(
  response: Response,
  maxResponseBytes: number,
): Promise<unknown> {
  const declaredValue = response.headers.get("content-length");
  let declared: number | undefined;
  if (declaredValue !== null) {
    if (!/^\d+$/u.test(declaredValue)) throw invalidJwks();
    declared = Number(declaredValue);
    if (!Number.isSafeInteger(declared) || declared > maxResponseBytes) {
      throw invalidJwks();
    }
  }
  const body = response.body;
  if (body === null) throw invalidJwks();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidJwks();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof PrismError) throw error;
    throw invalidJwks();
  } finally {
    reader.releaseLock();
  }
  if (declared !== undefined && declared !== total) throw invalidJwks();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalidJwks();
  }
}

function invalidJwks(): PrismError {
  return PrismError.of(
    "AUTHENTICATION_PROVIDER_INVALID",
    "OIDC JWKS response is malformed.",
  );
}

async function verifySignature(
  keys: readonly JsonWebKey[],
  kid: string,
  encodedHeader: string,
  encodedClaims: string,
  encodedSignature: string,
): Promise<boolean> {
  const jwk = keys.find((candidate) => candidate.kid === kid);
  if (jwk === undefined) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
  } catch {
    return false;
  }
}

function positiveMilliseconds(
  value: number | undefined,
  fallback: number,
  option: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw PrismError.of(
      "AUTHENTICATION_PROVIDER_CONFIGURATION_INVALID",
      `OIDC ${option} must be a positive finite number.`,
      { option, value: resolved },
    );
  }
  return resolved;
}

function positiveSafeInteger(
  value: number | undefined,
  fallback: number,
  option: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw PrismError.of(
      "AUTHENTICATION_PROVIDER_CONFIGURATION_INVALID",
      `OIDC ${option} must be a positive safe integer.`,
      { option, value: resolved },
    );
  }
  return resolved;
}

function parseHeader(encoded: string): JwtHeader | null {
  const value = parseJson(encoded);
  if (
    typeof value !== "object" ||
    value === null ||
    !("alg" in value) ||
    value.alg !== "RS256" ||
    !("kid" in value) ||
    typeof value.kid !== "string" ||
    value.kid.length === 0
  ) {
    return null;
  }
  return { alg: value.alg, kid: value.kid };
}

function parseClaims(encoded: string): JwtClaims | null {
  const value = parseJson(encoded);
  return isJwtClaims(value) ? value : null;
}

function isJwtClaims(value: unknown): value is JwtClaims {
  return (
    typeof value === "object" &&
    value !== null &&
    "iss" in value &&
    typeof value.iss === "string" &&
    "sub" in value &&
    typeof value.sub === "string" &&
    value.sub.length > 0 &&
    "aud" in value &&
    (typeof value.aud === "string" ||
      (Array.isArray(value.aud) && value.aud.every((item) => typeof item === "string"))) &&
    "exp" in value &&
    typeof value.exp === "number" &&
    (!("nbf" in value) || value.nbf === undefined || typeof value.nbf === "number")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSigningJsonWebKey(value: unknown): value is JsonWebKey {
  if (!isObject(value)) return false;
  const keyOperations = value.key_ops;
  return (
    value.kty === "RSA" &&
    typeof value.kid === "string" &&
    value.kid.length > 0 &&
    typeof value.n === "string" &&
    value.n.length > 0 &&
    typeof value.e === "string" &&
    value.e.length > 0 &&
    (value.alg === undefined || value.alg === "RS256") &&
    (value.use === undefined || value.use === "sig") &&
    (keyOperations === undefined ||
      (Array.isArray(keyOperations) &&
        keyOperations.every((operation) => typeof operation === "string") &&
        keyOperations.includes("verify")))
  );
}

function parseJson(encoded: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as unknown;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function stringList(value: unknown): readonly string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/[ ,]+/u).filter(Boolean);
  return [];
}
