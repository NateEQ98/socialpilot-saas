create table public.tiktok_oauth_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state_hash text not null,
  expires_at timestamptz not null
);

create table public.tiktok_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  open_id text not null,
  access_token text not null,
  expires_at timestamptz not null
);

alter table public.tiktok_oauth_states enable row level security;
alter table public.tiktok_connections enable row level security;
revoke all on public.tiktok_oauth_states, public.tiktok_connections from public, anon, authenticated;
grant select, insert, update, delete on public.tiktok_oauth_states, public.tiktok_connections to service_role;
