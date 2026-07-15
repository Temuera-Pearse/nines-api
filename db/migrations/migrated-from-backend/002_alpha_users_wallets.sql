create table if not exists users (
  id text primary key,
  username text not null,
  email text null,
  account_status text not null,
  date_of_birth date not null,
  age_verification_status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_account_status_chk
    check (account_status in ('pending', 'active', 'restricted', 'suspended', 'blocked', 'closed')),
  constraint users_age_verification_status_chk
    check (age_verification_status in ('unverified', 'self_attested', 'verified', 'underage', 'rejected'))
);

create unique index if not exists users_username_lower_uidx
  on users (lower(username));

create unique index if not exists users_email_lower_uidx
  on users (lower(email))
  where email is not null;

create index if not exists users_account_status_idx
  on users (account_status);

create table if not exists wallets (
  id text primary key,
  user_id text not null references users (id) on delete restrict,
  currency text not null,
  balance_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallets_currency_upper_chk
    check (currency = upper(currency)),
  constraint wallets_balance_non_negative_chk
    check (balance_minor >= 0),
  constraint wallets_user_currency_uidx unique (user_id, currency)
);

create index if not exists wallets_user_id_idx
  on wallets (user_id);

create table if not exists wallet_ledger_entries (
  id bigserial primary key,
  wallet_id text not null references wallets (id) on delete restrict,
  entry_type text not null,
  delta_minor bigint not null,
  balance_after_minor bigint not null,
  reference_type text null,
  reference_id text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint wallet_ledger_entry_type_chk
    check (entry_type in (
      'admin_credit',
      'admin_debit',
      'bet_stake',
      'bet_refund',
      'settlement_credit',
      'settlement_reversal',
      'adjustment'
    )),
  constraint wallet_ledger_delta_non_zero_chk
    check (delta_minor <> 0),
  constraint wallet_ledger_balance_non_negative_chk
    check (balance_after_minor >= 0)
);

create unique index if not exists wallet_ledger_ref_uidx
  on wallet_ledger_entries (wallet_id, entry_type, reference_type, reference_id)
  where reference_type is not null and reference_id is not null;

create index if not exists wallet_ledger_wallet_created_idx
  on wallet_ledger_entries (wallet_id, created_at desc);