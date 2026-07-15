create index if not exists bets_unsettled_race_idx
  on bets (race_id, created_at asc)
  where status = 'placed' and result_status = 'pending';