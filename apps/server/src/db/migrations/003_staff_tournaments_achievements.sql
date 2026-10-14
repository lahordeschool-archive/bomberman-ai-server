alter table users
  add column role text not null default 'player'
  check (role in ('player', 'moderator', 'admin'));

alter table matches drop constraint matches_kind_check;
alter table matches
  add constraint matches_kind_check check (kind in ('ranked', 'casual', 'tournament'));

create table tournaments (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,48}$'),
  name text not null check (char_length(name) between 3 and 80),
  description text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  cancelled_at timestamptz,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index tournaments_dates_idx on tournaments (starts_at desc, ends_at desc);

create table tournament_registrations (
  tournament_id uuid not null references tournaments (id) on delete cascade,
  bot_id uuid not null references bots (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  registered_at timestamptz not null default now(),
  last_matched_at timestamptz,
  games integer not null default 0,
  wins integer not null default 0,
  points integer not null default 0,
  primary key (tournament_id, bot_id),
  unique (tournament_id, user_id)
);
create index tournament_registrations_standings_idx
  on tournament_registrations (tournament_id, points desc, wins desc, games asc);

alter table matches
  add column tournament_id uuid references tournaments (id) on delete set null;
create index matches_tournament_idx on matches (tournament_id, ended_at desc);

create table achievements (
  slug text primary key,
  title text not null,
  description text not null,
  icon text not null,
  sort_order integer not null default 0
);

create table user_achievements (
  user_id uuid not null references users (id) on delete cascade,
  achievement_slug text not null references achievements (slug) on delete cascade,
  earned_at timestamptz not null default now(),
  detail jsonb,
  primary key (user_id, achievement_slug)
);

insert into achievements (slug, title, description, icon, sort_order) values
  ('first-match', 'Arena Debut', 'Complete your first competitive match.', 'sword', 10),
  ('first-win', 'First Victory', 'Win your first competitive match.', 'trophy', 20),
  ('veteran', 'Arena Veteran', 'Complete 25 competitive matches.', 'shield', 30),
  ('demolition-expert', 'Demolition Expert', 'Score 25 kills across competitive matches.', 'bomb', 40);
