# Staging validation report

Validation date: 2026-07-11 UTC  
Project: `rememory-staging`  
Project Ref: `vimtgwxzrhxzplzndqpc`  
Production project `rememory-web` was not modified.

## Result

Two consecutive complete validation cycles passed. Each cycle passed 24 RLS/Storage checks and 18 account-deletion checks. Synthetic users, IDs, images, and text were used exclusively.

### Cycle 1

- Seed: 26/26 passed, 2026-07-11T14:43:24Z to 14:43:27Z
- RLS and Storage: 24/24 passed, 2026-07-11T14:44:15Z to 14:44:19Z
- Account deletion: 18/18 passed, 2026-07-11T14:44:30Z to 14:44:34Z
- Evidence: `artifacts/staging-validation-seed-1783781007235.json`
- Evidence: `artifacts/staging-validation-validate-1783781059554.json`
- Evidence: `artifacts/staging-validation-delete-1783781074570.json`

The rollback then restored:

- `memories_own_all`, `fragments_own_all`, and `reflections_own_all`
- the four `memory_images_*_own` Storage policies
- FORCE RLS disabled on the three application tables
- `delete_current_user_data()` absent

### Cycle 2

- Seed: 26/26 passed, 2026-07-11T14:45:34Z to 14:45:35Z
- RLS and Storage: 24/24 passed, 2026-07-11T14:46:22Z to 14:46:25Z
- Account deletion: 18/18 passed, 2026-07-11T14:46:38Z to 14:46:41Z
- Evidence: `artifacts/staging-validation-seed-1783781135676.json`
- Evidence: `artifacts/staging-validation-validate-1783781185678.json`
- Evidence: `artifacts/staging-validation-delete-1783781201745.json`

## Verified behavior

- A and B can SELECT, INSERT, UPDATE, and DELETE their own memories.
- A and B cannot read, update, or delete the other user's memories.
- Cross-owner fragment and reflection creation is rejected with HTTP 403.
- Anonymous SELECT and INSERT are rejected with HTTP 401.
- Each user can upload and download an image under their own UUID path.
- Cross-owner Storage download is rejected with HTTP 400 and no object content.
- Missing and mismatched Origin requests are rejected with HTTP 403.
- A deletion body containing `user_id` is rejected with HTTP 400.
- A valid deletion returns HTTP 200.
- Deleted-user Auth lookup returns HTTP 404.
- Deleted-user DB, Profile, Settings, and Storage counts are zero.
- User B's DB, Profile, Settings, Storage, and Auth records remain present.

## Issues found and fixed

1. The RLS preflight variable `table_name` conflicted with the information-schema column. It was renamed to `required_table_name`; the failed transaction made no changes.
2. Anonymous SELECT returned HTTP 401 rather than 200 with zero rows. Both are secure outcomes; the test now accepts explicit denial or an empty result.
3. The Dashboard Editor now requires the `withSupabase` default-export runtime format. The function was migrated from `Deno.serve` and deployed with the official CLI.
4. With automatic table exposure disabled, `service_role` lacked table privileges for fixture setup and evidence queries. Explicit table privileges were added for staging administration only.
5. The initial seed did not assert Profile creation. The runner now records and requires Profile seed success.

## Final staging state

- Corrected RLS and Storage policies are applied.
- `delete-account` is deployed only to staging.
- `ALLOWED_ORIGINS` is `http://localhost:4173` in staging only.
- Synthetic user A is deleted; synthetic user B remains for inspection.
- The temporary CLI access token was revoked and removed from local configuration.
- Raw evidence and test credentials are Git-ignored.
