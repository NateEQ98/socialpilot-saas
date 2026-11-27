import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const origin = "https://ariavora.com";
const redirectUri = origin + "/tiktok-callback.html";
const api = "https://open.tiktokapis.com/v2";
const clientKey = Deno.env.get("TIKTOK_SANDBOX_CLIENT_KEY")?.trim() ?? "";
const clientSecret = Deno.env.get("TIKTOK_SANDBOX_CLIENT_SECRET")?.trim() ?? "";
const project = Deno.env.get("SUPABASE_URL")!;
const auth = createClient(project, Deno.env.get("SUPABASE_ANON_KEY")!);
const db = createClient(project, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const reply = (status: number, body: object) => Response.json(body, { status, headers });

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function oauth(path: string, params: Record<string, string>) {
  return await fetch(api + "/oauth/" + path + "/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, ...params }),
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
}

const connectionFields = "open_id,access_token,expires_at,refresh_token_ciphertext,refresh_expires_at";
const tokenEncoder = new TextEncoder();

interface Connection {
  open_id: string;
  access_token: string;
  expires_at: string;
  refresh_token_ciphertext: string | null;
  refresh_expires_at: string | null;
}

async function refreshKey() {
  const bytes = await crypto.subtle.digest("SHA-256", tokenEncoder.encode("Ariavora TikTok refresh token v1:" + clientSecret));
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealRefreshToken(token: string, userId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenEncoder.encode(userId) },
    await refreshKey(), tokenEncoder.encode(token),
  ));
  return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...ciphertext));
}

async function openRefreshToken(value: string, userId: string) {
  const [iv, ciphertext] = value.split(".").map(part => Uint8Array.from(atob(part), char => char.charCodeAt(0)));
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: tokenEncoder.encode(userId) }, await refreshKey(), ciphertext,
  );
  return new TextDecoder().decode(bytes);
}

function hasPublishingScope(scope: unknown) {
  return typeof scope === "string" && scope.split(",").some(value => value.trim() === "video.publish");
}

async function tokenFields(token: Record<string, unknown>, userId: string) {
  const now = Date.now();
  const refresh = typeof token.refresh_token === "string" && token.refresh_token.length > 0 &&
    typeof token.refresh_expires_in === "number" && Number.isFinite(token.refresh_expires_in) && token.refresh_expires_in > 0;
  return {
    access_token: token.access_token as string,
    expires_at: new Date(now + (token.expires_in as number) * 1000).toISOString(),
    refresh_token_ciphertext: refresh ? await sealRefreshToken(token.refresh_token as string, userId) : null,
    refresh_expires_at: refresh ? new Date(now + (token.refresh_expires_in as number) * 1000).toISOString() : null,
    refresh_claim_until: null,
  };
}

async function renewConnection(connection: Connection, userId: string) {
  const now = Date.now();
  if (!connection.refresh_token_ciphertext || !connection.refresh_expires_at ||
      Date.parse(connection.refresh_expires_at) <= now) return { connection, busy: false };

  // Claim the refresh so parallel requests cannot rotate the same token twice.
  const claim = new Date(now + 30_000).toISOString();
  const { data, error } = await db.from("tiktok_connections").update({ refresh_claim_until: claim })
    .eq("user_id", userId).eq("access_token", connection.access_token)
    .or("refresh_claim_until.is.null,refresh_claim_until.lt." + new Date(now).toISOString())
    .select("user_id").maybeSingle();
  if (error) throw error;
  if (!data) {
    const { data: current, error: readError } = await db.from("tiktok_connections")
      .select(connectionFields).eq("user_id", userId).maybeSingle();
    if (readError) throw readError;
    return { connection: current, busy: current?.access_token === connection.access_token };
  }

  const claimedRow = () => db.from("tiktok_connections").update({ refresh_claim_until: null })
    .eq("user_id", userId).eq("access_token", connection.access_token).eq("refresh_claim_until", claim);
  try {
    const refresh = await openRefreshToken(connection.refresh_token_ciphertext, userId).catch(() => null);
    if (!refresh) return { connection, busy: false };
    const response = await oauth("token", { grant_type: "refresh_token", refresh_token: refresh });
    const token = await response.json().catch(() => null);
    if (token?.error === "invalid_grant" || token?.error === "access_denied") {
      const { error: clearError } = await db.from("tiktok_connections").update({
        refresh_token_ciphertext: null, refresh_expires_at: null,
      }).eq("user_id", userId).eq("access_token", connection.access_token).eq("refresh_claim_until", claim);
      if (clearError) throw clearError;
      return { connection, busy: false };
    }
    if (!response.ok || token?.error || typeof token?.access_token !== "string" || !token.access_token ||
        token.open_id !== connection.open_id || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
        !hasPublishingScope(token.scope)) throw new Error("TikTok token refresh failed.");
    const credentials = await tokenFields(token, userId);
    const { data: saved, error: saveError } = await db.from("tiktok_connections").update(credentials)
      .eq("user_id", userId).eq("access_token", connection.access_token).eq("refresh_claim_until", claim)
      .select(connectionFields).maybeSingle();
    if (saveError) throw saveError;
    return { connection: saved, busy: false };
  } finally {
    const { error: releaseError } = await claimedRow();
    if (releaseError) throw releaseError;
  }
}

async function posting(path: string, token: string, body: object = {}) {
  const result = await fetch(api + "/post/publish/" + path + "/", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(12000),
  });
  const payload = await result.json();
  if (!result.ok || payload.error?.code !== "ok") throw new Error("TikTok rejected the publishing request.");
  return payload.data;
}

const maxVideoBytes = 32 * 1024 * 1024;

async function getVideo(url: string) {
  const source = new URL(url);
  if (source.protocol !== "https:" || source.username || source.password || source.port ||
      !(source.hostname === "fal.media" || source.hostname.endsWith(".fal.media"))) {
    throw new Error("Video source is unsupported.");
  }
  const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(25000) });
  const size = Number(response.headers.get("content-length"));
  if (!response.ok || !response.body || !Number.isSafeInteger(size) || size < 1 || size > maxVideoBytes) {
    await response.body?.cancel();
    throw new Error("Video cannot be transferred.");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > size) throw new Error("Video size changed.");
      bytes.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel();
  }
  if (offset !== size) throw new Error("The video transfer was incomplete.");
  return bytes;
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." });
  const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer) return reply(401, { error: "Sign in to Ariavora first." });
  const { data: { user }, error: authError } = await auth.auth.getUser(bearer);
  if (authError || !user || user.is_anonymous) return reply(401, { error: "Sign in to Ariavora first." });
  if (!clientKey || !clientSecret) return reply(503, { error: "TikTok sandbox is awaiting configuration." });
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object") return reply(400, { error: "Invalid request." });

  try {
    if (input.action === "start") {
      const state = crypto.randomUUID() + crypto.randomUUID();
      const { error } = await db.from("tiktok_oauth_states").upsert({
        user_id: user.id,
        state_hash: await hash(state),
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (error) throw error;
      const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
      url.search = new URLSearchParams({
        client_key: clientKey, scope: "user.info.basic,video.publish",
        response_type: "code", redirect_uri: redirectUri, state,
      }).toString();
      return reply(200, { url: url.href, state });
    }

    if (input.action === "complete") {
      if (typeof input.code !== "string" || !input.code || input.code.length > 4096 ||
          typeof input.state !== "string" || input.state.length !== 72) {
        return reply(400, { error: "TikTok returned an invalid authorization response." });
      }
      const { data: consumed, error } = await db.from("tiktok_oauth_states").delete()
        .eq("user_id", user.id).eq("state_hash", await hash(input.state))
        .gt("expires_at", new Date().toISOString()).select("user_id").maybeSingle();
      if (error) throw error;
      if (!consumed) return reply(400, { error: "This connection request expired. Start again in Video Studio." });
      const result = await oauth("token", {
        code: input.code, grant_type: "authorization_code", redirect_uri: redirectUri,
      });
      const token = await result.json().catch(() => null);
      if (!result.ok || token?.error) {
        const errorCode = typeof token?.error === "string" && /^[a-z_]{1,50}$/.test(token.error)
          ? token.error : "unknown";
        console.warn("TikTok OAuth token exchange failed", { status: result.status, errorCode });
        if (errorCode === "invalid_client") {
          return reply(502, { error: "TikTok rejected Ariavora's sandbox credentials (invalid_client)." });
        }
        if (errorCode === "invalid_grant") {
          return reply(400, { error: "TikTok rejected the authorization code (invalid_grant). Start a fresh connection in Video Studio." });
        }
        return reply(502, { error: `TikTok could not complete authorization (${errorCode}).` });
      }
      if (typeof token?.access_token !== "string" || !token.access_token ||
          typeof token.open_id !== "string" || !token.open_id ||
          !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
        return reply(502, { error: "TikTok returned an incomplete authorization response." });
      }
      if (!hasPublishingScope(token.scope)) {
        return reply(403, { error: "TikTok connected without publishing permission. Enable Post content to TikTok during authorization." });
      }
      const { error: saveError } = await db.from("tiktok_connections").upsert({
        user_id: user.id, open_id: token.open_id, ...await tokenFields(token, user.id),
      });
      if (saveError) throw saveError;
      return reply(200, { connected: true });
    }

    const { data, error } = await db.from("tiktok_connections")
      .select(connectionFields).eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    let connection = data;
    if (connection && Date.parse(connection.expires_at) <= Date.now()) {
      const renewal = await renewConnection(connection, user.id);
      if (renewal.busy) return reply(503, { error: "TikTok is renewing the connection. Try again in a moment." });
      connection = renewal.connection;
    }
    if (input.action === "status") {
      const linked = Boolean(connection);
      return reply(200, { linked, connected: linked && Date.parse(connection!.expires_at) > Date.now() });
    }
    if (input.action === "disconnect") {
      if (connection) {
        const result = await oauth("revoke", { token: connection.access_token });
        if (!result.ok && Date.parse(connection.expires_at) > Date.now()) {
          return reply(502, { error: "TikTok did not confirm disconnection. Please try again." });
        }
        const { error: removeError } = await db.from("tiktok_connections").delete()
          .eq("user_id", user.id).eq("access_token", connection.access_token);
        if (removeError) throw removeError;
      }
      return reply(200, { connected: false });
    }
    if (!connection || Date.parse(connection.expires_at) <= Date.now()) {
      return reply(409, { error: "Connect TikTok before publishing." });
    }
    const token = connection.access_token;

    if (input.action === "publish-status") {
      if (typeof input.publishId !== "string" || !input.publishId || input.publishId.length > 64) {
        return reply(400, { error: "Invalid TikTok publishing reference." });
      }
      const result = await posting("status/fetch", token, { publish_id: input.publishId });
      return reply(200, { status: result.status });
    }

    if (input.action === "creator" || input.action === "publish") {
      const creator = await posting("creator_info/query", token);
      if (!creator.privacy_level_options?.includes("SELF_ONLY")) {
        return reply(409, { error: "This TikTok account cannot publish a private sandbox video." });
      }
      if (input.action === "creator") {
        return reply(200, {
          username: creator.creator_username,
          nickname: creator.creator_nickname,
          maxDuration: creator.max_video_post_duration_sec,
        });
      }
      if (input.consent !== true || input.privacy !== "SELF_ONLY" ||
          input.username !== creator.creator_username ||
          typeof input.caption !== "string" || input.caption.length > 2200 ||
          typeof input.id !== "string" || !/^[a-f0-9-]{36}$/i.test(input.id)) {
        return reply(400, { error: "Review the account, caption, and visibility before publishing." });
      }
      const { data: job, error: jobError } = await db.from("video_generations")
        .select("video_url").eq("id", input.id).eq("user_id", user.id)
        .eq("status", "completed").maybeSingle();
      if (jobError) throw jobError;
      if (!job?.video_url) return reply(404, { error: "This completed video is unavailable." });
      const bytes = await getVideo(job.video_url);
      const initialized = await posting("video/init", token, {
        post_info: {
          title: input.caption,
          privacy_level: "SELF_ONLY",
          disable_comment: true,
          disable_duet: true,
          disable_stitch: true,
          is_aigc: true,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: bytes.length,
          chunk_size: bytes.length,
          total_chunk_count: 1,
        },
      });
      const uploadUrl = new URL(initialized.upload_url);
      if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password) throw new Error("Invalid upload URL.");
      try {
        const uploaded = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
          body: bytes,
          redirect: "error",
          signal: AbortSignal.timeout(35000),
        });
        if (!uploaded.ok) throw new Error("Transfer failed.");
      } catch {
        return reply(200, { publishId: initialized.publish_id, uploaded: false });
      }
      return reply(200, { publishId: initialized.publish_id, uploaded: true });
    }
    return reply(400, { error: "Unknown TikTok action." });
  } catch {
    return reply(500, { error: "The TikTok service could not complete this request." });
  }
});
