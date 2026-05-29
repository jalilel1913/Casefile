import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { z } from "zod";
import type { ToolDescriptor } from "./types.js";

export const McpFetcherInput = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST"]).default("GET"),
  headers: z.record(z.string(), z.string()).nullish(),
  body: z.string().nullish(),
  timeoutMs: z.number().int().min(100).max(30000).default(10000),
  maxBytes: z.number().int().min(1024).max(2_000_000).default(500_000),
  /**
   * Optional set of approved hostnames. When provided, every URL that is
   * fetched or redirected to must have a hostname in this set. This is the
   * network-layer enforcement point for the agent's threat-intel allowlist —
   * it catches redirect chains that escape the approved host set.
   */
  allowedHosts: z.set(z.string()).nullish(),
});
export type McpFetcherInput = z.infer<typeof McpFetcherInput>;

export const McpFetcherOutput = z.object({
  url: z.string(),
  status: z.number().int(),
  ok: z.boolean(),
  contentType: z.string().nullable(),
  byteLength: z.number().int(),
  truncated: z.boolean(),
  body: z.string(),
  fetchedAt: z.string(),
  elapsedMs: z.number(),
});
export type McpFetcherOutput = z.infer<typeof McpFetcherOutput>;

const PRIVATE_HOSTNAME_RE =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|localhost$)/i;

function isPrivateOrInvalidHost(hostname: string): string | null {
  const lower = hostname.toLowerCase();
  // IPv6 literals — URL strips brackets so we get bare ::1 / fe80:: / fc00:: forms
  if (lower.includes(":")) {
    if (lower === "::1" || lower === "::" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
      return `IPv6 loopback/private/link-local '${hostname}'`;
    }
  }
  // Decimal-encoded IPv4 (e.g. 2130706433 == 127.0.0.1)
  if (/^\d+$/.test(lower)) {
    const n = Number(lower);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      const octets = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
      if (PRIVATE_HOSTNAME_RE.test(octets + ".")) {
        return `decimal-encoded private/loopback IP '${hostname}' -> ${octets}`;
      }
      return `numeric-encoded IPv4 host '${hostname}' is not allowed`;
    }
  }
  // Hex-encoded IPv4 (e.g. 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(lower)) {
    return `hex-encoded IPv4 host '${hostname}' is not allowed`;
  }
  if (PRIVATE_HOSTNAME_RE.test(lower)) {
    return `private/loopback host '${hostname}'`;
  }
  return null;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — check the embedded v4
    const v4 = lower.slice(7);
    if (isIP(v4) === 4 && isPrivateIPv4(v4)) return true;
  }
  return false;
}

async function resolvesToPrivate(hostname: string): Promise<string | null> {
  // Skip DNS if hostname is already an IP literal (covered by isPrivateOrInvalidHost)
  if (isIP(hostname) !== 0) return null;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    return `DNS lookup failed for '${hostname}': ${err instanceof Error ? err.message : String(err)}`;
  }
  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) {
      return `host '${hostname}' resolves to private/loopback IPv4 ${address}`;
    }
    if (family === 6 && isPrivateIPv6(address)) {
      return `host '${hostname}' resolves to private/loopback IPv6 ${address}`;
    }
  }
  return null;
}

export const mcpFetcher: ToolDescriptor<typeof McpFetcherInput, typeof McpFetcherOutput> = {
  name: "mcpFetcher",
  description:
    "Fetches an external HTTP(S) URL and returns the response body as text along with status code, content-type, and byte length. Has a hard timeout and response-size cap. Refuses requests to private/loopback hostnames or IP literals (decimal/hex-encoded IPv4, IPv6 loopback/ULA/link-local), and additionally resolves the hostname via DNS and refuses any name that resolves to a private/loopback/CGNAT/multicast address (SSRF defense in depth). This is the only tool in the suite that touches the network.",
  inputSchema: McpFetcherInput,
  outputSchema: McpFetcherOutput,
  run: async ({ url, method, headers, body, timeoutMs, maxBytes, allowedHosts }) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Refusing non-http(s) scheme '${parsed.protocol}'`);
    }
    const literalReason = isPrivateOrInvalidHost(parsed.hostname);
    if (literalReason) {
      throw new Error(`Refusing to fetch ${literalReason} — SSRF protection`);
    }
    const dnsReason = await resolvesToPrivate(parsed.hostname);
    if (dnsReason) {
      throw new Error(`Refusing to fetch ${dnsReason} — SSRF protection`);
    }
    // Enforce allowlist on the initial URL (callers such as the agent adapter
    // also pre-check this, but we validate here too so the policy is upheld
    // even when mcpFetcher is invoked directly).
    if (allowedHosts != null && !allowedHosts.has(parsed.hostname.toLowerCase())) {
      throw new Error(
        `Refusing to fetch '${parsed.hostname}' — not in the approved host allowlist`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const MAX_REDIRECTS = 5;
    try {
      let currentUrl = url;
      let redirectsFollowed = 0;
      let res: Response;
      while (true) {
        res = await fetch(currentUrl, {
          method,
          headers: headers ?? {},
          body: method === "POST" ? body : undefined,
          signal: controller.signal,
          redirect: "manual",
        });
        if (res.status >= 300 && res.status < 400) {
          if (redirectsFollowed >= MAX_REDIRECTS) {
            throw new Error(`Too many redirects (limit ${MAX_REDIRECTS})`);
          }
          const location = res.headers.get("location");
          if (!location) {
            throw new Error(`Redirect response missing Location header`);
          }
          // Resolve relative redirect URLs against the current URL
          const redirectUrl = new URL(location, currentUrl);
          if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
            throw new Error(`Refusing redirect to non-http(s) scheme '${redirectUrl.protocol}' — SSRF protection`);
          }
          const redirectLiteralReason = isPrivateOrInvalidHost(redirectUrl.hostname);
          if (redirectLiteralReason) {
            throw new Error(`Refusing redirect to ${redirectLiteralReason} — SSRF protection`);
          }
          const redirectDnsReason = await resolvesToPrivate(redirectUrl.hostname);
          if (redirectDnsReason) {
            throw new Error(`Refusing redirect to ${redirectDnsReason} — SSRF protection`);
          }
          // Enforce allowlist on each redirect target so an allowlisted domain
          // cannot chain out to an arbitrary public host for exfiltration.
          if (allowedHosts != null && !allowedHosts.has(redirectUrl.hostname.toLowerCase())) {
            throw new Error(
              `Refusing redirect to '${redirectUrl.hostname}' — not in the approved host allowlist`,
            );
          }
          currentUrl = redirectUrl.href;
          redirectsFollowed += 1;
          continue;
        }
        break;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const truncated = buf.byteLength > maxBytes;
      const slice = truncated ? buf.subarray(0, maxBytes) : buf;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      return {
        url: currentUrl,
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get("content-type"),
        byteLength: buf.byteLength,
        truncated,
        body: text,
        fetchedAt: new Date(startedAt).toISOString(),
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
