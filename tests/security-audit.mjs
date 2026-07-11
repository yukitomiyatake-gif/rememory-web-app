import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("assets/app.js");
const css = read("assets/app-ui.css");
const html = read("index.html");
const rlsMigration = read("supabase/staging/01_rls_and_account_delete.sql");
const storageMigration = read("supabase/staging/02_storage_policies.sql");
const rollback = read("supabase/staging/rollback.sql");
const deleteFunction = read("supabase/functions/delete-account/index.ts");

const failures = [];
const requireMatch = (name, value, pattern) => {
  if (!pattern.test(value)) failures.push(`${name}: required pattern is missing`);
};
const forbidMatch = (name, value, pattern) => {
  if (pattern.test(value)) failures.push(`${name}: forbidden pattern is present`);
};

forbidMatch("production app has no debug code", app, /debug|data-debug|delete-all|reset-memory|reanalyze/i);
forbidMatch("production app has no authentication bypass", app, /guest-login|localLogin|LOCAL_AUTH|guest-session/i);
forbidMatch("production app has no detailed console logging", app, /console\.(?:log|info|warn|error|debug)/);
forbidMatch("production stylesheet has no debug UI", css, /\.debug(?:-|\b)/i);
forbidMatch("production HTML has no Google client id", html, /google-client-id/i);
requireMatch("CSP is present", html, /Content-Security-Policy/);
requireMatch("Supabase SDK is pinned", html, /@supabase\/supabase-js@\d+\.\d+\.\d+\/dist\/umd\/supabase\.min\.js/);
requireMatch("Supabase SDK uses SRI", html, /integrity="sha384-[^"]+"/);
requireMatch("cryptographic ids are used", app, /crypto\.(?:randomUUID|getRandomValues)/);
requireMatch("image MIME allowlist exists", app, /image\/jpeg.*image\/png.*image\/webp/s);
requireMatch("image byte limit exists", app, /MAX_IMAGE_BYTES/);
requireMatch("image dimension limit exists", app, /MAX_IMAGE_PIXELS/);
requireMatch("account deletion uses Edge Function", app, /functions\.invoke\("delete-account"/);
requireMatch("account deletion requires authenticated user", deleteFunction, /admin\.auth\.getUser\(token\)/);
requireMatch("account deletion uses server-side admin API", deleteFunction, /auth\.admin\.deleteUser/);
requireMatch("RLS migration enables RLS", rlsMigration, /enable row level security/g);
requireMatch("RLS migration has ownership checks", rlsMigration, /auth\.uid\(\).*user_id/s);
requireMatch("account deletion uses profiles.id", rlsMigration, /delete from public\.profiles where id = current_user_id/);
requireMatch("fragment writes retain parent ownership", rlsMigration, /m\.id = memory_fragments\.memory_id and m\.user_id = \(select auth\.uid\(\)\)/);
requireMatch("reflection writes retain parent ownership", rlsMigration, /m\.id = memory_reflections\.memory_id and m\.user_id = \(select auth\.uid\(\)\)/);
forbidMatch("profiles policies are preserved", rlsMigration, /drop policy[^;]* on public\.profiles/i);
forbidMatch("user_settings policies are preserved", rlsMigration, /drop policy[^;]* on public\.user_settings/i);
requireMatch("Storage remains private", storageMigration, /set public = false/);
requireMatch("Storage path checks first folder", storageMigration, /storage\.foldername\(name\)\)\[1\]/);
requireMatch("Storage protected operations check owner", storageMigration, /owner_id = \(select auth\.uid\(\)\)::text/);
requireMatch("HEIC remains explicitly allowed", storageMigration, /image\/heic/);
requireMatch("HEIF remains explicitly allowed", storageMigration, /image\/heif/);
requireMatch("rollback restores existing memory policy", rollback, /create policy memories_own_all/);
requireMatch("Edge Function requires origin secret", deleteFunction, /Deno\.env\.get\("ALLOWED_ORIGINS"\)/);
forbidMatch("Edge Function has no origin fallback", deleteFunction, /DEFAULT_ORIGIN/);
requireMatch("Edge Function rejects extra body keys", deleteFunction, /Object\.keys\(body\).*key !== "confirmation"/s);
forbidMatch("Edge Function never reads a requested user id", deleteFunction, /body\.(?:user_?id|target)/i);
requireMatch("RLS migration stops for unknown policies", rlsMigration, /unknown application-table policy/);
requireMatch("Storage migration stops for unknown policies", storageMigration, /unknown storage\.objects policy/);

const secretPatterns = [
  /service[_-]?role\s*[:=]\s*["'][^"']+/i,
  /client[_-]?secret\s*[:=]\s*["'][^"']+/i,
  /private[_-]?key\s*[:=]\s*["'][^"']+/i,
  /postgres(?:ql)?:\/\/[^\s"']+/i
];
for (const [path, value] of [["index.html", html], ["assets/app.js", app], ["Edge Function", deleteFunction]]) {
  for (const pattern of secretPatterns) forbidMatch(`${path} has no embedded secret`, value, pattern);
}

if (failures.length) {
  failures.forEach((failure) => process.stderr.write(`FAIL ${failure}\n`));
  process.exit(1);
}

process.stdout.write("Security audit checks passed.\n");
