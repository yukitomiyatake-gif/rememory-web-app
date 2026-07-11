import { withSupabase } from "npm:@supabase/server";

const BUCKET = "memory-images";
const CONFIRMATION = "DELETE_MY_ACCOUNT";

function response(origin: string | null, status: number, body: Record<string, unknown>) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin"
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return new Response(JSON.stringify(body), {
    status,
    headers
  });
}

function allowedOrigin(request: Request) {
  const origin = request.headers.get("Origin") || "";
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origin || !configured.length) return "";
  return configured.includes(origin) ? origin : "";
}

async function listUserObjects(admin: any, prefix: string) {
  const paths: string[] = [];
  const pending = [prefix];

  while (pending.length) {
    const current = pending.pop()!;
    let offset = 0;

    while (true) {
      const { data, error } = await admin.storage.from(BUCKET).list(current, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" }
      });
      if (error) throw new Error("storage-list-failed");
      if (!data?.length) break;

      for (const item of data) {
        const path = `${current}/${item.name}`;
        if (item.metadata) paths.push(path);
        else pending.push(path);
      }

      if (data.length < 100) break;
      offset += data.length;
    }
  }

  return paths;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    const origin = allowedOrigin(request);
    if (!Deno.env.get("ALLOWED_ORIGINS")) return response(null, 503, { error: "service_unavailable" });
    if (!origin) return response(null, 403, { error: "origin_not_allowed" });
    if (request.method === "OPTIONS") return response(origin, 204, {});
    if (request.method !== "POST") return response(origin, 405, { error: "method_not_allowed" });

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return response(origin, 400, { error: "invalid_request" });
    }
    if (Object.keys(body).some((key) => key !== "confirmation")) {
      return response(origin, 400, { error: "invalid_request" });
    }
    if (body.confirmation !== CONFIRMATION) return response(origin, 400, { error: "confirmation_required" });

    const claims = ctx.userClaims as Record<string, unknown> | undefined;
    const userId = String(claims?.id || claims?.sub || "");
    if (!userId) return response(origin, 401, { error: "authentication_required" });

    try {
      const paths = await listUserObjects(ctx.supabaseAdmin, userId);
      for (let index = 0; index < paths.length; index += 100) {
        const { error } = await ctx.supabaseAdmin.storage.from(BUCKET).remove(paths.slice(index, index + 100));
        if (error) throw new Error("storage-delete-failed");
      }

      const { error: dataError } = await ctx.supabase.rpc("delete_current_user_data");
      if (dataError) throw new Error("database-delete-failed");

      const { error: authError } = await ctx.supabaseAdmin.auth.admin.deleteUser(userId, false);
      if (authError) throw new Error("auth-delete-failed");
    } catch {
      return response(origin, 500, { error: "account_delete_failed" });
    }

    return response(origin, 200, { deleted: true });
  })
};
