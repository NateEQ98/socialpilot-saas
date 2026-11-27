import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const site = "https://ariavora.com";
const redirectUri = site + "/meta-callback.html";
const appId = "2516427118882227";
const configurationId = "2033381600682957";
const graph = "https://graph.facebook.com/v25.0/";
const secret = Deno.env.get("META_APP_SECRET")?.trim();
const project = Deno.env.get("SUPABASE_URL")!;
const auth = createClient(project, Deno.env.get("SUPABASE_ANON_KEY")!);
const db = createClient(project, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const headers = {
  "Access-Control-Allow-Origin": site,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const reply = (status: number, body: object) => Response.json(body, { status, headers });
const encoder = new TextEncoder();
const stateFormat = /^[a-f0-9-]{36}$/i;

async function cryptKey() {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode("Ariavora Meta token v1:" + secret));
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(token: string, userId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(userId) }, await cryptKey(), encoder.encode(token),
  );
  return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function decrypt(value: string, userId: string) {
  const [iv, ciphertext] = value.split(".").map(part => Uint8Array.from(atob(part), char => char.charCodeAt(0)));
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(userId) }, await cryptKey(), ciphertext,
  );
  return new TextDecoder().decode(bytes);
}

class MetaError extends Error {
  constructor(readonly code: number | undefined) {
    super("Meta API request failed");
  }
}

async function graphGet(path: string, params: Record<string, string>, token?: string) {
  const url = new URL(path, graph);
  url.search = new URLSearchParams(params).toString();
  if (token) {
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
    url.searchParams.set("appsecret_proof",
      Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join(""));
  }
  const response = await fetch(url, {
    headers: token ? { Authorization: "Bearer " + token } : {},
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error) {
    throw new MetaError(typeof body?.error?.code === "number" ? body.error.code : undefined);
  }
  return body;
}

interface Page {
  id: string;
  name: string;
  instagram_business_account?: { id: string; username?: string };
}

async function destinations(token: string) {
  const pages: Array<{ id: string; name: string; instagram: string | null }> = [];
  let after: string | undefined;
  do {
    const result = await graphGet("me/accounts", {
      fields: "id,name,instagram_business_account{id,username}",
      limit: "100",
      ...(after ? { after } : {}),
    }, token);
    if (!Array.isArray(result.data)) throw new MetaError(undefined);
    pages.push(...result.data.map((page: Page) => ({
      id: page.id,
      name: page.name,
      instagram: page.instagram_business_account?.username ?? null,
    })));
    const next = result.paging?.next ? result.paging?.cursors?.after : undefined;
    after = typeof next === "string" && next !== after ? next : undefined;
  } while (after && pages.length < 500);
  if (pages.length) return pages;

  // Some granular grants identify Pages only in the token's target IDs.
  const inspected = await graphGet("debug_token", { input_token: token }, appId + "|" + secret);
  const grant = inspected.data;
  if (!grant?.is_valid || String(grant.app_id) !== appId || !Array.isArray(grant.granular_scopes)) {
    return pages;
  }

  const pageScopes = new Set(["pages_show_list", "pages_manage_posts", "pages_read_engagement"]);
  const ids = new Set<string>();
  for (const scope of grant.granular_scopes) {
    if (!pageScopes.has(scope?.scope) || !Array.isArray(scope.target_ids)) continue;
    for (const id of scope.target_ids) {
      if (typeof id === "string" && /^\d{1,30}$/.test(id)) ids.add(id);
    }
  }
  for (const id of [...ids].slice(0, 20)) {
    try {
      const page = await graphGet(id, { fields: "id,name,access_token,instagram_business_account{id,username}" }, token);
      if (page.id === id && typeof page.name === "string" && typeof page.access_token === "string" && page.access_token) {
        pages.push({ id, name: page.name, instagram: page.instagram_business_account?.username ?? null });
      }
    } catch (error) {
      if (!(error instanceof MetaError)) throw error;
    }
  }
  return pages;
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." });
  const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer) return reply(401, { error: "Sign in to Ariavora first." });
  const { data: { user }, error: authError } = await auth.auth.getUser(bearer);
  if (authError || !user || user.is_anonymous) return reply(401, { error: "Sign in to Ariavora first." });
  if (!secret) return reply(503, { error: "Meta publishing is awaiting server configuration." });
  const input = await request.json().catch(() => null);

  try {
    if (input?.action === "start") {
      const state = crypto.randomUUID();
      const now = Date.now();
      const { error: cleanupError } = await db.from("meta_publishing_oauth_states").delete()
        .lt("expires_at", new Date(now).toISOString());
      if (cleanupError) throw cleanupError;
      const { error } = await db.from("meta_publishing_oauth_states").insert({
        state, user_id: user.id, expires_at: new Date(now + 10 * 60_000).toISOString(),
      });
      if (error) throw error;
      const url = new URL("https://www.facebook.com/v25.0/dialog/oauth");
      url.search = new URLSearchParams({
        client_id: appId, config_id: configurationId, redirect_uri: redirectUri, response_type: "code", state,
      }).toString();
      return reply(200, { url: url.href, state });
    }
    if (input?.action === "complete") {
      if (typeof input.state !== "string" || !stateFormat.test(input.state) ||
          typeof input.code !== "string" || !input.code || input.code.length > 4096) {
        return reply(400, { error: "Meta returned an invalid authorization response." });
      }
      const { data, error } = await db.from("meta_publishing_oauth_states").delete()
        .eq("state", input.state).eq("user_id", user.id).gt("expires_at", new Date().toISOString())
        .select("state").maybeSingle();
      if (error) throw error;
      if (!data) return reply(400, { error: "This connection expired. Start a fresh Meta connection." });
      const token = await graphGet("oauth/access_token", {
        client_id: appId, client_secret: secret, redirect_uri: redirectUri, code: input.code,
      });
      if (typeof token.access_token !== "string" || !token.access_token ||
          !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
        return reply(502, { error: "Meta did not return a usable authorization token." });
      }
      const pages = await destinations(token.access_token);
      if (!pages.length) return reply(400, { error: "Meta did not return a Page this account can manage. Check Facebook Page access and the selected permissions." });
      const { error: saveError } = await db.from("meta_publishing_connections").upsert({
        user_id: user.id, encrypted_token: await encrypt(token.access_token, user.id),
        expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      });
      if (saveError) throw saveError;
      return reply(200, { connected: true, pages });
    }
    if (input?.action === "status") {
      const { data, error } = await db.from("meta_publishing_connections")
        .select("encrypted_token,expires_at").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      if (!data || Date.parse(data.expires_at) <= Date.now()) return reply(200, { connected: false });
      const token = await decrypt(data.encrypted_token, user.id).catch(() => null);
      if (!token) return reply(200, { connected: false });
      const pages = await destinations(token);
      return reply(200, { connected: pages.length > 0, pages });
    }
    if (input?.action === "disconnect") {
      const { error } = await db.from("meta_publishing_connections").delete().eq("user_id", user.id);
      if (error) throw error;
      return reply(200, { connected: false });
    }
    return reply(400, { error: "Invalid request." });
  } catch (error) {
    if (error instanceof MetaError) {
      console.warn("Meta connection rejected", { code: error.code });
      if (input?.action === "status" && error.code === 190) return reply(200, { connected: false });
      return reply(502, { error: "Meta rejected the connection. Check the app permissions and try again." });
    }
    console.error("Ariavora Meta connection failed");
    return reply(500, { error: "The Meta connection is temporarily unavailable." });
  }
});
