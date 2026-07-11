begin;

drop function if exists public.delete_current_user_data();

drop policy if exists rememory_memories_select_own on public.memories;
drop policy if exists rememory_memories_insert_own on public.memories;
drop policy if exists rememory_memories_update_own on public.memories;
drop policy if exists rememory_memories_delete_own on public.memories;
create policy memories_own_all on public.memories for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists rememory_fragments_select_own on public.memory_fragments;
drop policy if exists rememory_fragments_insert_own on public.memory_fragments;
drop policy if exists rememory_fragments_update_own on public.memory_fragments;
drop policy if exists rememory_fragments_delete_own on public.memory_fragments;
create policy fragments_own_all on public.memory_fragments for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_fragments.memory_id and m.user_id = (select auth.uid()))
);

drop policy if exists rememory_reflections_select_own on public.memory_reflections;
drop policy if exists rememory_reflections_insert_own on public.memory_reflections;
drop policy if exists rememory_reflections_update_own on public.memory_reflections;
drop policy if exists rememory_reflections_delete_own on public.memory_reflections;
create policy reflections_own_all on public.memory_reflections for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_reflections.memory_id and m.user_id = (select auth.uid()))
);

alter table public.memories no force row level security;
alter table public.memory_fragments no force row level security;
alter table public.memory_reflections no force row level security;

drop policy if exists rememory_storage_select_own on storage.objects;
drop policy if exists rememory_storage_insert_own on storage.objects;
drop policy if exists rememory_storage_update_own on storage.objects;
drop policy if exists rememory_storage_delete_own on storage.objects;

create policy memory_images_select_own on storage.objects for select to authenticated
using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy memory_images_insert_own on storage.objects for insert to authenticated
with check (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy memory_images_update_own on storage.objects for update to authenticated
using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy memory_images_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'memory-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

update storage.buckets
set public = false,
    file_size_limit = 15728640,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
where id = 'memory-images';

drop index if exists public.rememory_memories_user_id_idx;
drop index if exists public.rememory_fragments_user_id_idx;
drop index if exists public.rememory_reflections_user_id_idx;

commit;
