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
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m || !env.SESSION_SECRET) return false;
  const [, exp, sig] = m as unknown as [string, string, string];
  if (Number(exp) < Date.now()) return false;
  return safeEqual(env.SESSION_SECRET, sig, await hmac(env.SESSION_SECRET, exp));
}
