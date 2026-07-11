begin;

do $$
begin
  if not exists (select 1 from storage.buckets where id = 'memory-images') then
    raise exception 'Stopped: memory-images bucket is missing';
  end if;
  if exists (select 1 from storage.buckets where id = 'memory-images' and public) then
    raise exception 'Stopped: memory-images must already be private';
  end if;
  if exists (
    select 1 from storage.objects
    where bucket_id = 'memory-images'
      and (owner_id is null or (storage.foldername(name))[1] <> owner_id)
  ) then
    raise exception 'Stopped: an existing object path does not match owner_id';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname not in (
        'memory_images_select_own', 'memory_images_insert_own', 'memory_images_update_own', 'memory_images_delete_own',
        'rememory_storage_select_own', 'rememory_storage_insert_own', 'rememory_storage_update_own', 'rememory_storage_delete_own'
      )
  ) then
    raise exception 'Stopped: an unknown storage.objects policy exists; review it manually';
  end if;
end
$$;

-- Keep HEIC/HEIF in the bucket allowlist. The web app rejects them before upload
-- and does not currently convert those formats in every supported browser.
update storage.buckets
set public = false,
    file_size_limit = 15728640,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
where id = 'memory-images';

drop policy if exists memory_images_select_own on storage.objects;
drop policy if exists memory_images_insert_own on storage.objects;
drop policy if exists memory_images_update_own on storage.objects;
drop policy if exists memory_images_delete_own on storage.objects;
drop policy if exists rememory_storage_select_own on storage.objects;
drop policy if exists rememory_storage_insert_own on storage.objects;
drop policy if exists rememory_storage_update_own on storage.objects;
drop policy if exists rememory_storage_delete_own on storage.objects;

create policy rememory_storage_select_own on storage.objects for select to authenticated
using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text and owner_id = (select auth.uid())::text);
create policy rememory_storage_insert_own on storage.objects for insert to authenticated
with check (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy rememory_storage_update_own on storage.objects for update to authenticated
using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text and owner_id = (select auth.uid())::text)
with check (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text and owner_id = (select auth.uid())::text);
create policy rememory_storage_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text and owner_id = (select auth.uid())::text);

commit;
