import type { Env } from "./types";

/**
 * Who may sign in: read straight from the Cloudflare Access policy "Tým newsletterů", so the list in the
 * app is never out of date. Uses a read-only API token (secret CF_API_TOKEN); the Worker cannot change
 * who has access. Last sign-in comes from Zero Trust users when the token is allowed to read them.
 */
export interface TeamMember { email: string; lastLogin: string | null }
export interface TeamInfo { configured: boolean; members: TeamMember[]; domains: string[]; error?: string }

const API = "https://api.cloudflare.com/client/v4";

async function cf<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${(env.CF_API_TOKEN ?? "").trim()}` } });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
  if (!res.ok || !data.success) throw new Error(data.errors?.[0]?.message || `Cloudflare API ${res.status}`);
  return data.result as T;
}

type Rule = { email?: { email: string }; email_domain?: { domain: string } };

export async function getTeam(env: Env): Promise<TeamInfo> {
  if (!env.CF_API_TOKEN || !env.ACCESS_ACCOUNT_ID || !env.ACCESS_POLICY_ID) return { configured: false, members: [], domains: [] };
  const acc = env.ACCESS_ACCOUNT_ID;
  try {
    const policy = await cf<{ include?: Rule[] }>(env, `/accounts/${acc}/access/policies/${env.ACCESS_POLICY_ID}`);
    const rules = policy.include ?? [];
    const emails = rules.map((r) => r.email?.email).filter((e): e is string => Boolean(e));
    const domains = rules.map((r) => r.email_domain?.domain).filter((d): d is string => Boolean(d));
    const last = new Map<string, string>();
    try {
      const users = await cf<{ email: string; last_successful_login?: string | null }[]>(env, `/accounts/${acc}/access/users?per_page=100`);
      for (const u of users) if (u.last_successful_login) last.set(u.email.toLowerCase(), u.last_successful_login);
    } catch {
      /* token may not be allowed to read users – the list still works without last sign-in */
    }
    const members = emails
      .map((email) => ({ email, lastLogin: last.get(email.toLowerCase()) ?? null }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return { configured: true, members, domains };
  } catch (e) {
    // tell an invalid/mis-pasted token apart from a missing permission
    let why = (e as Error).message;
    try {
      const v = await cf<{ status: string }>(env, `/accounts/${acc}/tokens/verify`);
      why += v.status === "active" ? " – klíč je platný, chybí mu oprávnění" : ` – klíč je ve stavu ${v.status}`;
    } catch {
      why += " – klíč je neplatný nebo špatně vložený";
    }
    return { configured: true, members: [], domains: [], error: why };
  }
}
