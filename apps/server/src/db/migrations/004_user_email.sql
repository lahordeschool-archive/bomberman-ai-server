-- Email is required for new registrations; existing accounts stay nullable.
alter table users
  add column email text;

create unique index users_email_lower_idx on users (lower(email)) where email is not null;
