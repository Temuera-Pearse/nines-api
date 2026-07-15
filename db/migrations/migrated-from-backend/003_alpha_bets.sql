create table if not exists bets (
  id text primary key,
  user_id text not null references users (id) on delete restrict,
  wallet_id text not null references wallets (id) on delete restrict,
  race_id text not null references races (race_id) on delete restrict,
  currency text not null,
  bet_type text not null,
  selection_id text not null,
  stake_minor bigint not null,
  payout_minor bigint null,
  status text not null,
  result_status text not null,
  placed_at timestamptz not null default now(),
  settled_at timestamptz null,
  refunded_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bets_currency_upper_chk
    check (currency = upper(currency)),
  constraint bets_bet_type_chk
    check (bet_type in ('win')),
  constraint bets_stake_positive_chk
    check (stake_minor > 0),
  constraint bets_payout_non_negative_chk
    check (payout_minor is null or payout_minor >= 0),
  constraint bets_status_chk
    check (status in ('placed', 'settled', 'refunded', 'cancelled')),
  constraint bets_result_status_chk
    check (result_status in ('pending', 'won', 'lost', 'void', 'refunded'))
);

create index if not exists bets_user_created_idx
  on bets (user_id, created_at desc);

create index if not exists bets_race_created_idx
  on bets (race_id, created_at asc);

create index if not exists bets_status_result_idx
  on bets (status, result_status);