create table public.meta_video_publications (
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id uuid not null,
  page_id text not null,
  platform text not null check (platform in ('facebook','instagram')),
  state text not null check (state in ('sending','processing','submitted','failed')),
  remote_id text,
  instagram_id text,
  primary key (user_id, video_id, page_id, platform)
);
alter table public.meta_video_publications enable row level security;
revoke all on public.meta_video_publications from public, anon, authenticated;
grant select, insert, update, delete on public.meta_video_publications to service_role;
