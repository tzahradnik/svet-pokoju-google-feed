import type { Env } from "./types";

const COOKIE = "nl_session";
const SESSION_HOURS = 12;
const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings via their HMAC digests. */
async function safeEqual(secret: string, a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function checkPassword(env: Env, password: string): Promise<boolean> {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) throw new Error("APP_PASSWORD / SESSION_SECRET nejsou nastavené");
  return safeEqual(env.SESSION_SECRET, password, env.APP_PASSWORD);
}

export async function sessionCookie(env: Env, url: URL): Promise<string> {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  const token = `${exp}.${await hmac(env.SESSION_SECRET, String(exp))}`;
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export async function isAuthenticated(env: Env, req: Request): Promise<boolean> {
  if (accessEnabled(env)) return (await accessUser(env, req)) !== null;
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m || !env.SESSION_SECRET) return false;
  const [, exp, sig] = m as unknown as [string, string, string];
  if (Number(exp) < Date.now()) return false;
  return safeEqual(env.SESSION_SECRET, sig, await hmac(env.SESSION_SECRET, exp));
}

/* ---------- Cloudflare Access (one-time e-mail code) ---------- */
// When ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, Cloudflare Access is the only way in:
// Access sends the user a one-time code by e-mail and passes a signed JWT to the Worker,
// which we verify here (signature, audience, issuer, expiry). The password login is then off.

export function accessEnabled(env: Env): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

type Jwk = JsonWebKey & { kid: string };
let certs: { at: number; keys: Jwk[] } | null = null;

async function accessKeys(team: string, force = false): Promise<Jwk[]> {
  if (!force && certs && Date.now() - certs.at < 3600_000) return certs.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  certs = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
  return certs.keys;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

/** Returns the signed-in user's e-mail, or null when the Access token is missing or invalid. */
export async function accessUser(env: Env, req: Request): Promise<string | null> {
  const cookie = req.headers.get("Cookie") ?? "";
  const token = req.headers.get("Cf-Access-Jwt-Assertion") ?? cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid?: string; alg?: string };
    if (header.alg !== "RS256") return null;
    let jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as { aud?: string | string[]; iss?: string; exp?: number; email?: string };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    return claims.email ?? null;
  } catch {
    return null;
  }
}
