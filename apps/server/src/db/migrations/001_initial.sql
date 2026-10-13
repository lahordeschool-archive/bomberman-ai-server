create table users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text not null,
  password_hash text not null,
  is_house boolean not null default false,
  created_at timestamptz not null default now(),
  password_changed_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  csrf_token text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expiry_idx on sessions (expires_at);

create table bots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  name text not null,
  active_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index bots_owner_name_idx on bots (owner_id, lower(name)) where deleted_at is null;

create table bot_versions (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots (id) on delete cascade,
  version integer not null,
  source text not null,
  source_hash text not null,
  sdk_version integer not null,
  visibility text not null check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  unique (bot_id, version)
);

alter table bots
  add constraint bots_active_version_fk
  foreign key (active_version_id) references bot_versions (id) on delete set null;

-- Submitted code is evidence for ranked results: versions can be added, never rewritten.
create function forbid_bot_version_update() returns trigger language plpgsql as $$
begin
  raise exception 'bot versions are immutable';
end;
$$;
create trigger bot_versions_immutable before update on bot_versions
  for each row execute function forbid_bot_version_update();

create table ranked_queue (
  bot_id uuid primary key references bots (id) on delete cascade,
  enqueued_at timestamptz not null default now(),
  last_matched_at timestamptz
);

create table matches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('ranked', 'casual')),
  status text not null check (status in ('running', 'completed', 'aborted')),
  engine_version integer not null,
  sdk_version integer not null,
  seed bigint not null,
  player_count integer not null,
  settings jsonb not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_tick integer,
  end_reason text,
  winner_slot integer,
  final_hash text,
  rated boolean not null default false
);
create index matches_status_idx on matches (status, started_at desc);
create index matches_ended_idx on matches (ended_at desc);

create table match_participants (
  match_id uuid not null references matches (id) on delete cascade,
  slot integer not null,
  kind text not null check (kind in ('ranked', 'browser', 'house')),
  bot_id uuid references bots (id),
  bot_version_id uuid references bot_versions (id),
  user_id uuid references users (id) on delete set null,
  bot_name text not null,
  placement integer,
  score integer,
  kills integer,
  walls integer,
  items integer,
  died_at_tick integer,
  rating_before double precision,
  rating_after double precision,
  primary key (match_id, slot)
);
create index match_participants_bot_idx on match_participants (bot_id);
create index match_participants_user_idx on match_participants (user_id);

create table match_events (
  match_id uuid not null references matches (id) on delete cascade,
  seq integer not null,
  tick integer not null,
  slot integer not null,
  intent text not null check (intent in ('u', 'd', 'l', 'r', 'b', 'i')),
  primary key (match_id, seq)
);

create table ratings (
  bot_id uuid primary key references bots (id) on delete cascade,
  rating double precision not null default 1200,
  games integer not null default 0,
  wins integer not null default 0,
  updated_at timestamptz not null default now()
);
create index ratings_rating_idx on ratings (rating desc);

create table audit_log (
  id bigserial primary key,
  user_id uuid references users (id) on delete set null,
  action text not null,
  ip text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_user_idx on audit_log (user_id, created_at desc);
