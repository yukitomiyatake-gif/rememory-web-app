begin;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['memories', 'memory_fragments', 'memory_reflections']
  loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise exception 'Security migration stopped: required table public.% is missing', table_name;
    end if;

    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and information_schema.columns.table_name = table_name
        and column_name = 'user_id'
        and data_type = 'uuid'
    ) then
      raise exception 'Security migration stopped: public.%.user_id uuid is missing', table_name;
    end if;
  end loop;

  if not exists (select 1 from storage.buckets where id = 'memory-images') then
    raise exception 'Security migration stopped: storage bucket memory-images is missing';
  end if;

  if exists (select 1 from storage.buckets where id <> 'memory-images') then
    raise exception 'Security migration stopped: additional Storage buckets exist; review their policies before applying';
  end if;
end
$$;

alter table public.memories enable row level security;
alter table public.memories force row level security;
alter table public.memory_fragments enable row level security;
alter table public.memory_fragments force row level security;
alter table public.memory_reflections enable row level security;
alter table public.memory_reflections force row level security;

revoke all on public.memories from anon;
revoke all on public.memory_fragments from anon;
revoke all on public.memory_reflections from anon;

grant select, insert, update, delete on public.memories to authenticated;
grant select, insert, update, delete on public.memory_fragments to authenticated;
grant select, insert, update, delete on public.memory_reflections to authenticated;

do $$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('memories', 'memory_fragments', 'memory_reflections')
  loop
    execute format('drop policy %I on %I.%I', policy_record.policyname, policy_record.schemaname, policy_record.tablename);
  end loop;
end
$$;

drop policy if exists "rememory_memories_select_own" on public.memories;
drop policy if exists "rememory_memories_insert_own" on public.memories;
drop policy if exists "rememory_memories_update_own" on public.memories;
drop policy if exists "rememory_memories_delete_own" on public.memories;

create policy "rememory_memories_select_own"
on public.memories for select to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_memories_insert_own"
on public.memories for insert to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_memories_update_own"
on public.memories for update to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_memories_delete_own"
on public.memories for delete to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "rememory_fragments_select_own" on public.memory_fragments;
drop policy if exists "rememory_fragments_insert_own" on public.memory_fragments;
drop policy if exists "rememory_fragments_update_own" on public.memory_fragments;
drop policy if exists "rememory_fragments_delete_own" on public.memory_fragments;

create policy "rememory_fragments_select_own"
on public.memory_fragments for select to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_fragments_insert_own"
on public.memory_fragments for insert to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_fragments_update_own"
on public.memory_fragments for update to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_fragments_delete_own"
on public.memory_fragments for delete to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "rememory_reflections_select_own" on public.memory_reflections;
drop policy if exists "rememory_reflections_insert_own" on public.memory_reflections;
drop policy if exists "rememory_reflections_update_own" on public.memory_reflections;
drop policy if exists "rememory_reflections_delete_own" on public.memory_reflections;

create policy "rememory_reflections_select_own"
on public.memory_reflections for select to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_reflections_insert_own"
on public.memory_reflections for insert to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_reflections_update_own"
on public.memory_reflections for update to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create policy "rememory_reflections_delete_own"
on public.memory_reflections for delete to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create index if not exists rememory_memories_user_id_idx on public.memories (user_id);
create index if not exists rememory_fragments_user_id_idx on public.memory_fragments (user_id);
create index if not exists rememory_reflections_user_id_idx on public.memory_reflections (user_id);

update storage.buckets
set public = false,
    file_size_limit = 15728640,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'memory-images';

do $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
  loop
    execute format('drop policy %I on storage.objects', policy_record.policyname);
  end loop;
end
$$;

drop policy if exists "rememory_storage_select_own" on storage.objects;
drop policy if exists "rememory_storage_insert_own" on storage.objects;
drop policy if exists "rememory_storage_update_own" on storage.objects;
drop policy if exists "rememory_storage_delete_own" on storage.objects;

create policy "rememory_storage_select_own"
on storage.objects for select to authenticated
using (
  bucket_id = 'memory-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
);

create policy "rememory_storage_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'memory-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "rememory_storage_update_own"
on storage.objects for update to authenticated
using (
  bucket_id = 'memory-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
)
with check (
  bucket_id = 'memory-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
);

create policy "rememory_storage_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'memory-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
);

create or replace function public.delete_current_user_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  delete from public.memory_reflections where user_id = current_user_id;
  delete from public.memory_fragments where user_id = current_user_id;
  delete from public.memories where user_id = current_user_id;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_settings' and column_name = 'user_id'
  ) then
    execute 'delete from public.user_settings where user_id = $1' using current_user_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'user_id'
  ) then
    execute 'delete from public.profiles where user_id = $1' using current_user_id;
  end if;
end;
$$;

revoke all on function public.delete_current_user_data() from public, anon;
grant execute on function public.delete_current_user_data() to authenticated;

commit;
