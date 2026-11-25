import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const PROJECT_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const FAL_KEY = Deno.env.get("FAL_KEY") || "";
const MODEL = "alibaba/wan-3.0-prime/text-to-video";
const API = "https://queue.fal.run/" + MODEL;
const QUEUE_API = "https://queue.fal.run/" + MODEL.split("/").slice(0,2).join("/");
const allowed = new Set(["https://nateeq98.github.io", "http://localhost:3000", "http://127.0.0.1:5500"]);
const responseHeaders = (origin: string | null) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": origin && allowed.has(origin) ? origin : "https://nateeq98.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
  "Cache-Control": "no-store",
});
function reply(status: number, body: Record<string, unknown>, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}
function safeError(error: unknown) { return error instanceof Error ? error.message.slice(0, 250) : "Request failed"; }
Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed" }, origin);
  if (origin && !allowed.has(origin)) return reply(403, { error: "Origin not allowed" }, origin);
  if (!PROJECT_URL || !ANON_KEY || !SERVICE_KEY) return reply(503, { error: "Backend configuration is incomplete" }, origin);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return reply(401, { error: "Sign in to use AI Video Studio" }, origin);
  const auth = createClient(PROJECT_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await auth.auth.getUser(token);
  if (authError || !authData.user || authData.user.is_anonymous) return reply(401, { error: "Your session has expired. Sign in again." }, origin);
  const user = authData.user;
  const db = createClient(PROJECT_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let input: Record<string, unknown>;
  try { input = await request.json(); } catch { return reply(400, { error: "Invalid JSON" }, origin); }
  const action = String(input.action || "list");

  if (action === "list") {
    const { data, error } = await db.from("video_generations")
      .select("id,prompt,aspect_ratio,status,video_url,created_at,error_message")
      .eq("user_id", user.id).order("created_at", { ascending: false }).limit(12);
    if (error) return reply(500, { error: "Could not load your videos" }, origin);
    return reply(200, { jobs: data }, origin);
  }

  if (action === "create") {
    if (!FAL_KEY) return reply(503, { error: "AI Video Studio is awaiting secure provider activation. No credits were used." }, origin);
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const aspect = typeof input.aspect_ratio === "string" ? input.aspect_ratio : "9:16";
    if (prompt.length < 12 || prompt.length > 1200 || !["9:16", "16:9", "1:1"].includes(aspect)) {
      return reply(400, { error: "Enter a description between 12 and 1,200 characters and choose a valid format." }, origin);
    }
    const { data: jobId, error: reserveError } = await db.rpc("reserve_video_generation", {
      p_user: user.id, p_prompt: prompt, p_aspect: aspect,
    });
    if (reserveError) {
      const msg = String(reserveError.message || "");
      return reply(msg.includes("Monthly video limit") ? 429 : msg.includes("subscription") ? 402 : 400,
        { error: msg.includes("Monthly video limit") ? "You have used your 10 video generations for this month." :
          msg.includes("subscription") ? "An active paid Ariavora subscription is required." : "Video request was not accepted." }, origin);
    }
    try {
      const submitted = await fetch(API, {
        method: "POST",
        headers: { "Authorization": "Key " + FAL_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt, aspect_ratio: aspect, resolution: "720p", duration: 5,
          audio: false, enable_safety_checker: true, enable_prompt_expansion: true,
        }),
        signal: AbortSignal.timeout(25000),
      });
      const output = await submitted.json().catch(() => ({}));
      if (!submitted.ok || !output.request_id) {
        await db.from("video_generations").update({ status: "failed", error_message: "Provider rejected the request", updated_at: new Date().toISOString() }).eq("id", jobId).eq("user_id", user.id);
        return reply(submitted.status === 402 ? 503 : 502, { error: "Video provider is unavailable. No video was returned." }, origin);
      }
      const requestId = String(output.request_id);
      if (!/^[a-zA-Z0-9-]{10,128}$/.test(requestId)) return reply(502, { error: "Unexpected video provider response" }, origin);
      const { error: saveError } = await db.from("video_generations").update({
        status: "submitted", provider_request_id: requestId, updated_at: new Date().toISOString(),
      }).eq("id", jobId).eq("user_id", user.id);
      if (saveError) return reply(503, { error: "Video submitted but job tracking failed. Contact support with reference " + jobId }, origin);
      return reply(202, { id: jobId, status: "submitted", message: "Rendering started. You can check the result here." }, origin);
    } catch (error) {
      await db.from("video_generations").update({ status: "failed", error_message: "Could not reach video provider", updated_at: new Date().toISOString() }).eq("id", jobId).eq("user_id", user.id);
      return reply(502, { error: "Could not reach the video provider: " + safeError(error) }, origin);
    }
  }

  if (action === "status") {
    const id = String(input.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply(400, { error: "Invalid job ID" }, origin);
    const { data: job, error } = await db.from("video_generations").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (error || !job) return reply(404, { error: "Video not found" }, origin);
    if (job.status === "completed" || job.status === "failed") {
      return reply(200, { id: job.id, status: job.status, video_url: job.video_url, error: job.error_message }, origin);
    }
    if (!job.provider_request_id) return reply(200, { id: job.id, status: "reserved" }, origin);
    if (!FAL_KEY) return reply(503, { error: "Video provider is not configured" }, origin);
    try {
      const headers = { "Authorization": "Key " + FAL_KEY };
      const statusResult = await fetch(QUEUE_API + "/requests/" + encodeURIComponent(job.provider_request_id) + "/status", { headers, signal: AbortSignal.timeout(12000) });
      if (!statusResult.ok) return reply(502, { error: "Video status is temporarily unavailable" }, origin);
      const status = await statusResult.json();
      if (status.status !== "COMPLETED") return reply(200, { id: job.id, status: "submitted", position: status.queue_position ?? null }, origin);
      const completed = await fetch(QUEUE_API + "/requests/" + encodeURIComponent(job.provider_request_id), { headers, signal: AbortSignal.timeout(15000) });
      if (!completed.ok) return reply(502, { error: "Video output is not ready. Try checking again." }, origin);
      const result = await completed.json();
      const videoUrl = result?.video?.url;
      if (typeof videoUrl !== "string" || !videoUrl.startsWith("https://")) {
        return reply(502, { error: "Video output was not available yet. Try checking again." }, origin);
      }
      await db.from("video_generations").update({
        status: "completed", video_url: videoUrl, updated_at: new Date().toISOString(),
      }).eq("id", id).eq("user_id", user.id);
      return reply(200, { id, status: "completed", video_url: videoUrl }, origin);
    } catch { return reply(502, { error: "Could not retrieve video status. Try again." }, origin); }
  }
  return reply(400, { error: "Unknown action" }, origin);
});
