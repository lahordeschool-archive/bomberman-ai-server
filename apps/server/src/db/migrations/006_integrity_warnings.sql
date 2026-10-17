alter table match_participants
  add column killed_by_slot integer,
  add column escape_available boolean not null default false;

create table integrity_warnings (
  id bigserial primary key,
  kind text not null check (kind in ('source_similarity', 'win_association', 'repeated_avoidable_death')),
  fingerprint text not null unique,
  severity text not null check (severity in ('medium', 'high')),
  detail jsonb not null,
  occurrences integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index integrity_warnings_recent_idx on integrity_warnings (last_seen_at desc);
