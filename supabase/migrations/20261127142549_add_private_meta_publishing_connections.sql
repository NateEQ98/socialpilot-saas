create table public.meta_publishing_oauth_states (
  state uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
create index meta_publishing_oauth_states_expiration on public.meta_publishing_oauth_states (expires_at);
create table public.meta_publishing_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_token text not null,
  expires_at timestamptz not null
);
alter table public.meta_publishing_oauth_states enable row level security;
alter table public.meta_publishing_connections enable row level security;
revoke all on public.meta_publishing_oauth_states, public.meta_publishing_connections from public, anon, authenticated;
grant select, insert, update, delete on public.meta_publishing_oauth_states, public.meta_publishing_connections to service_role;
