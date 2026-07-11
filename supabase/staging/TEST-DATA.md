# Test data setup

Use only a separate staging project. Never reuse real email addresses, production UUIDs, photos, or access tokens.

1. In Authentication > Users, create two disposable users: A and B.
2. Sign in as each user through the staging app to obtain that user's normal session. Do not use a service-role key in client tests.
3. As user A, create one memory, nine fragments, one reflection, one settings row, and one profile.
4. As user B, create the same fixture set with different IDs.
5. Upload for each user one synthetic image and its fragments under:
   `USER_UUID/MEMORY_ID/FILE_NAME`
6. Record only the disposable user UUIDs and fixture IDs in a local ignored file such as `.env.staging.local`.
7. Confirm every fixture row has the expected owner and every Storage object has matching `owner_id` before applying the staging SQL.

The preferred setup path is the staging application itself because it exercises the same authenticated API and payloads as production. Synthetic blank images must be used; do not copy production Storage objects.

HEIC and HEIF remain allowed at bucket level during validation. The current web app accepts only JPEG, PNG, and WebP and does not provide reliable cross-browser HEIC/HEIF conversion.
