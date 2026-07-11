import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("assets/app.js");
const css = read("assets/app-ui.css");
const html = read("index.html");
const migration = read("supabase/migrations/20260711130000_harden_rememory_security.sql");
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
requireMatch("RLS migration enables RLS", migration, /enable row level security/g);
requireMatch("RLS migration has ownership checks", migration, /auth\.uid\(\).*user_id/s);
requireMatch("Storage is private", migration, /set public = false/);
requireMatch("Storage path checks first folder", migration, /storage\.foldername\(name\)\)\[1\]/);

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
