import type { Env } from "./types";

const API = "https://api2.ecomailapp.cz";

async function call<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.ECOMAIL_API_KEY) throw new Error("Ecomail zatím není napojený – chybí ECOMAIL_API_KEY. Zatím můžete e-mail stáhnout jako HTML.");
  const res = await fetch(API + path, {
    ...init,
    headers: { key: env.ECOMAIL_API_KEY, "Content-Type": "application/json", Accept: "application/json", ...init.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Ecomail API vrátilo chybu ${res.status}: ${body.slice(0, 300)}`);
  return (body ? JSON.parse(body) : {}) as T;
}

export interface EcomailList {
  id: number;
  name: string;
}

export async function listLists(env: Env): Promise<EcomailList[]> {
  const data = await call<unknown>(env, "/lists");
  const arr = Array.isArray(data) ? data : ((data as { data?: unknown[] }).data ?? []);
  return (arr as { id: number; name: string }[]).map((l) => ({ id: l.id, name: l.name }));
}

export interface DraftInput {
  title: string;
  subject: string;
  html: string;
  listIds: number[];
  fromName: string;
  fromEmail: string;
  replyTo: string;
}

/** Creates a campaign DRAFT. Ecomail sends it only after /campaign/{id}/send, which this tool never calls. */
export async function createDraft(env: Env, d: DraftInput): Promise<{ id: number }> {
  return call<{ id: number }>(env, "/campaigns", {
    method: "POST",
    body: JSON.stringify({
      title: d.title,
      from_name: d.fromName,
      from_email: d.fromEmail,
      reply_to: d.replyTo,
      subject: d.subject,
      html_text: d.html,
      recepient_lists: d.listIds, // sic – Ecomail's field name
    }),
  });
}
