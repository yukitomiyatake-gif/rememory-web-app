# Staging validation checklist

Run API operations with the normal anon/publishable key plus the specified user's access token. Never expose a secret/service key to the browser.

## Baseline identities

- Anonymous: no Authorization header
- User A: user A access token
- User B: user B access token

## Database

- [ ] Anonymous SELECT returns no personal rows for all five public tables.
- [ ] Anonymous INSERT, UPDATE, and DELETE are rejected.
- [ ] A and B can SELECT, INSERT, UPDATE, and DELETE their own memories.
- [ ] A cannot SELECT, UPDATE, or DELETE B's memory; repeat B against A.
- [ ] A cannot insert or update a fragment using B's `memory_id`.
- [ ] A cannot insert or update a reflection using B's `memory_id`.
- [ ] A cannot write rows whose `user_id` is B.
- [ ] Existing `profiles` and `user_settings` policies are unchanged.

## Storage

- [ ] The bucket remains Private.
- [ ] Anonymous list and download are rejected.
- [ ] A can upload, download, update, and delete under `A_UUID/...`.
- [ ] A cannot list, download, upload, update, or delete under `B_UUID/...`.
- [ ] A cannot update or delete an object whose `owner_id` is not A.
- [ ] Existing JPEG, PNG, WebP, HEIC, and HEIF objects remain readable by their owner.

## Account deletion

- [ ] A request without a JWT is rejected.
- [ ] A request from an origin absent from `ALLOWED_ORIGINS` is rejected.
- [ ] Supplying another user ID in the body has no effect; the function derives the target only from A's verified JWT.
- [ ] Deleting A removes A's Storage prefix, reflections, fragments, memories, settings, profile, and Auth user.
- [ ] No row, object, profile, settings row, or Auth user belonging to B is changed.
- [ ] Repeating the deletion request cannot delete B or any unrelated data.

## Evidence and pass rule

Save redacted request status codes, row counts, policy exports, Storage counts, and Edge Function logs. Passing requires every allow-case to succeed, every deny-case to fail, zero cross-user changes, and a successful rollback rehearsal.
