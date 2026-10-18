-- Operational and smoke-test accounts can exercise the API without entering rated play.
alter table users
  add column ranked_eligible boolean not null default true;

-- Deploy Check was created as a normal player during a production deployment check.
-- Keep its account, bot, versions, ratings, and match history as evidence, but remove
-- it from matchmaking. Leaderboard queries exclude ranked-ineligible owners.
update users
set ranked_eligible = false
where username = 'deploycheck';

delete from ranked_queue q
using bots b, users u
where q.bot_id = b.id
  and b.owner_id = u.id
  and not u.ranked_eligible;
