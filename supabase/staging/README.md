# Staging security validation

These files are for a separate staging Supabase project. Do not link this directory to `rememory-web` and do not run these files in production.

## Files

- `01_rls_and_account_delete.sql`: table RLS and authenticated deletion RPC
- `02_storage_policies.sql`: private bucket settings and Storage policies
- `rollback.sql`: restores the policy shape observed in production on 2026-07-11
- `TEST-DATA.md`: isolated test-user and fixture setup
- `VALIDATION.md`: required authorization and account-deletion tests

## Order

1. Create a separate staging project and restore a schema-only copy.
2. Create users A and B and the fixtures in `TEST-DATA.md`.
3. Save exports of `pg_policies`, grants, functions, bucket settings, and test data.
4. Run `01_rls_and_account_delete.sql` in staging SQL Editor.
5. Run `02_storage_policies.sql` in staging SQL Editor.
6. Set `ALLOWED_ORIGINS` to the exact staging origin.
7. Deploy `delete-account` to staging with JWT verification enabled.
8. Complete every item in `VALIDATION.md`.
9. Run `rollback.sql` in staging and repeat the baseline smoke test.

The SQL scripts intentionally stop when the staging schema, data ownership, bucket, or policy inventory differs from the audited production shape.
