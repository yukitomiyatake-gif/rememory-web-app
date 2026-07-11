import { createClient } from "npm:@supabase/supabase-js@2.110.2";

const BUCKET = "memory-images";
const CONFIRMATION = "DELETE_MY_ACCOUNT";
const DEFAULT_ORIGIN = "https://yukitomiyatake-gif.github.io";

function response(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Vary": "Origin"
    }
  });
}

function allowedOrigin(request: Request) {
  const origin = request.headers.get("Origin") || "";
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || DEFAULT_ORIGIN)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origin) return DEFAULT_ORIGIN;
  return configured.includes(origin) ? origin : "";
}

async function listUserObjects(admin: ReturnType<typeof createClient>, prefix: string) {
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

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  if (!origin) return response(DEFAULT_ORIGIN, 403, { error: "origin_not_allowed" });
  if (request.method === "OPTIONS") return response(origin, 204, {});
  if (request.method !== "POST") return response(origin, 405, { error: "method_not_allowed" });

  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return response(origin, 401, { error: "authentication_required" });

  let body: { confirmation?: string };
  try {
    body = await request.json();
  } catch {
    return response(origin, 400, { error: "invalid_request" });
  }
  if (body.confirmation !== CONFIRMATION) return response(origin, 400, { error: "confirmation_required" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRoleKey || !publishableKey) return response(origin, 503, { error: "service_unavailable" });

  const token = authorization.slice("Bearer ".length);
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const caller = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const user = userData.user;
  if (userError || !user) return response(origin, 401, { error: "authentication_required" });

  try {
    const paths = await listUserObjects(admin, user.id);
    for (let index = 0; index < paths.length; index += 100) {
      const { error } = await admin.storage.from(BUCKET).remove(paths.slice(index, index + 100));
      if (error) throw new Error("storage-delete-failed");
    }

    const { error: dataError } = await caller.rpc("delete_current_user_data");
    if (dataError) throw new Error("database-delete-failed");

    const { error: authError } = await admin.auth.admin.deleteUser(user.id, false);
    if (authError) throw new Error("auth-delete-failed");
  } catch {
    return response(origin, 500, { error: "account_delete_failed" });
  }

  return response(origin, 200, { deleted: true });
});
