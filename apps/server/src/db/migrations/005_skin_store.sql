alter table bots add column skin_slug text;
alter table match_participants add column skin_slug text;

create table user_wallets (
  user_id uuid primary key references users (id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  earned integer not null default 0 check (earned >= 0),
  updated_at timestamptz not null default now()
);

create table currency_awards (
  user_id uuid not null references users (id) on delete cascade,
  match_id uuid not null references matches (id) on delete cascade,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default now(),
  primary key (user_id, match_id)
);

create table user_skins (
  user_id uuid not null references users (id) on delete cascade,
  skin_slug text not null,
  price_paid integer not null check (price_paid >= 0),
  purchased_at timestamptz not null default now(),
  primary key (user_id, skin_slug)
);
