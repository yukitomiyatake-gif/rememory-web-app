begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memories (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  status text not null default 'sleeping' check (status = any (array['sleeping', 'fragmenting', 'viewed_original', 'not_yet', 'kept_closed'])),
  original_image_path text not null,
  created_at timestamptz not null default now(),
  available_at timestamptz,
  updated_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create table public.memory_fragments (
  id text primary key,
  memory_id text not null references public.memories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  fragment_index smallint not null check (fragment_index >= 0 and fragment_index <= 8),
  image_path text not null,
  is_unlocked boolean not null default false,
  unlocked_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  unique (memory_id, fragment_index)
);

create table public.memory_reflections (
  id text primary key,
  memory_id text not null references public.memories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  fragment_stage smallint,
  reflection_type text not null default 'fragment',
  body text not null default '',
  could_not_remember boolean not null default false,
  created_at timestamptz not null default now(),
  local_date date,
  payload jsonb not null default '{}'::jsonb
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index memories_user_available_idx on public.memories (user_id, available_at);
create index memories_user_created_idx on public.memories (user_id, created_at desc);
create index fragments_memory_idx on public.memory_fragments (memory_id, fragment_index);
create index reflections_memory_created_idx on public.memory_reflections (memory_id, created_at);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger memories_set_updated_at before update on public.memories
for each row execute function public.set_updated_at();
create trigger user_settings_set_updated_at before update on public.user_settings
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.memories enable row level security;
alter table public.memory_fragments enable row level security;
alter table public.memory_reflections enable row level security;
alter table public.user_settings enable row level security;

revoke all on public.profiles, public.memories, public.memory_fragments, public.memory_reflections, public.user_settings from anon;
grant select, insert, update, delete on public.profiles, public.memories, public.memory_fragments, public.memory_reflections, public.user_settings to authenticated;
grant select, insert, update, delete on public.profiles, public.memories, public.memory_fragments, public.memory_reflections, public.user_settings to service_role;

create policy profiles_select_own on public.profiles for select to authenticated
using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated
using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy memories_own_all on public.memories for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy fragments_own_all on public.memory_fragments for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_fragments.memory_id and m.user_id = (select auth.uid()))
);
create policy reflections_own_all on public.memory_reflections for all to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (select 1 from public.memories m where m.id = memory_reflections.memory_id and m.user_id = (select auth.uid()))
);
create policy settings_own_all on public.user_settings for all to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

commit;
