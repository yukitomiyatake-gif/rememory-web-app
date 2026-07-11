begin;

do $$
declare
  required_table_name text;
begin
  foreach required_table_name in array array['memories', 'memory_fragments', 'memory_reflections']
  loop
    if to_regclass(format('public.%I', required_table_name)) is null then
      raise exception 'Stopped: required table public.% is missing', required_table_name;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and information_schema.columns.table_name = required_table_name
        and column_name = 'user_id' and data_type = 'uuid' and is_nullable = 'NO'
    ) then
      raise exception 'Stopped: public.%.user_id must be uuid not null', required_table_name;
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'id' and data_type = 'uuid' and is_nullable = 'NO'
  ) then
    raise exception 'Stopped: public.profiles.id must be uuid not null';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_settings'
      and column_name = 'user_id' and data_type = 'uuid' and is_nullable = 'NO'
  ) then
    raise exception 'Stopped: public.user_settings.user_id must be uuid not null';
  end if;

  if exists (select 1 from public.memories where user_id is null)
    or exists (select 1 from public.memory_fragments where user_id is null)
    or exists (select 1 from public.memory_reflections where user_id is null) then
    raise exception 'Stopped: a protected table contains a null user_id';
  end if;
  if exists (
    select 1 from public.memory_fragments f
    left join public.memories m on m.id = f.memory_id
    where m.id is null or m.user_id <> f.user_id
  ) then
    raise exception 'Stopped: memory_fragments has a missing or cross-owner parent';
  end if;
  if exists (
    select 1 from public.memory_reflections r
    left join public.memories m on m.id = r.memory_id
    where m.id is null or m.user_id <> r.user_id
  ) then
    raise exception 'Stopped: memory_reflections has a missing or cross-owner parent';
  end if;
  if exists (
    select 1 from public.memories m left join auth.users u on u.id = m.user_id where u.id is null
  ) or exists (
    select 1 from public.memory_fragments f left join auth.users u on u.id = f.user_id where u.id is null
  ) or exists (
    select 1 from public.memory_reflections r left join auth.users u on u.id = r.user_id where u.id is null
  ) or exists (
    select 1 from public.profiles p left join auth.users u on u.id = p.id where u.id is null
  ) or exists (
    select 1 from public.user_settings s left join auth.users u on u.id = s.user_id where u.id is null
  ) then
    raise exception 'Stopped: an owner does not exist in auth.users';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('memories', 'memory_fragments', 'memory_reflections')
      and policyname not in (
        'memories_own_all', 'fragments_own_all', 'reflections_own_all',
        'rememory_memories_select_own', 'rememory_memories_insert_own', 'rememory_memories_update_own', 'rememory_memories_delete_own',
        'rememory_fragments_select_own', 'rememory_fragments_insert_own', 'rememory_fragments_update_own', 'rememory_fragments_delete_own',
        'rememory_reflections_select_own', 'rememory_reflections_insert_own', 'rememory_reflections_update_own', 'rememory_reflections_delete_own'
      )
  ) then
    raise exception 'Stopped: an unknown application-table policy exists; review it manually';
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
grant select, insert, update, delete on public.memories, public.memory_fragments, public.memory_reflections to authenticated;

drop policy if exists memories_own_all on public.memories;
drop policy if exists rememory_memories_select_own on public.memories;
drop policy if exists rememory_memories_insert_own on public.memories;
drop policy if exists rememory_memories_update_own on public.memories;
drop policy if exists rememory_memories_delete_own on public.memories;

create policy rememory_memories_select_own on public.memories for select to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy rememory_memories_insert_own on public.memories for insert to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy rememory_memories_update_own on public.memories for update to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy rememory_memories_delete_own on public.memories for delete to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists fragments_own_all on public.memory_fragments;
drop policy if exists rememory_fragments_select_own on public.memory_fragments;
drop policy if exists rememory_fragments_insert_own on public.memory_fragments;
drop policy if exists rememory_fragments_update_own on public.memory_fragments;
drop policy if exists rememory_fragments_delete_own on public.memory_fragments;

create policy rememory_fragments_select_own on public.memory_fragments for select to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy rememory_fragments_insert_own on public.memory_fragments for insert to authenticated
with check (
  (select auth.uid()) is not null and (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_fragments.memory_id and m.user_id = (select auth.uid()))
);
create policy rememory_fragments_update_own on public.memory_fragments for update to authenticated
using (
  (select auth.uid()) is not null and (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_fragments.memory_id and m.user_id = (select auth.uid()))
)
with check (
  (select auth.uid()) is not null and (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_fragments.memory_id and m.user_id = (select auth.uid()))
);
create policy rememory_fragments_delete_own on public.memory_fragments for delete to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists reflections_own_all on public.memory_reflections;
drop policy if exists rememory_reflections_select_own on public.memory_reflections;
drop policy if exists rememory_reflections_insert_own on public.memory_reflections;
drop policy if exists rememory_reflections_update_own on public.memory_reflections;
drop policy if exists rememory_reflections_delete_own on public.memory_reflections;

create policy rememory_reflections_select_own on public.memory_reflections for select to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy rememory_reflections_insert_own on public.memory_reflections for insert to authenticated
with check (
  (select auth.uid()) is not null and (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_reflections.memory_id and m.user_id = (select auth.uid()))
);
create policy rememory_reflections_update_own on public.memory_reflections for update to authenticated
using (
  (select auth.uid()) is not null and (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_reflections.memory_id and m.user_id = (select auth.uid()))
)
with check (
  (select auth.uid()) is not null and (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_reflections.memory_id and m.user_id = (select auth.uid()))
);
create policy rememory_reflections_delete_own on public.memory_reflections for delete to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create index if not exists rememory_memories_user_id_idx on public.memories (user_id);
create index if not exists rememory_fragments_user_id_idx on public.memory_fragments (user_id);
create index if not exists rememory_reflections_user_id_idx on public.memory_reflections (user_id);

create or replace function public.delete_current_user_data()
returns void language plpgsql security definer set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  delete from public.memory_reflections where user_id = current_user_id;
  delete from public.memory_fragments where user_id = current_user_id;
  delete from public.memories where user_id = current_user_id;
  delete from public.user_settings where user_id = current_user_id;
  delete from public.profiles where id = current_user_id;
end;
$$;

revoke all on function public.delete_current_user_data() from public, anon;
grant execute on function public.delete_current_user_data() to authenticated;

commit;
