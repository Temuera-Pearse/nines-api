CREATE TABLE players (
  id UUID PRIMARY KEY,
  email TEXT NULL,
  display_name TEXT NULL,
  account_status TEXT NOT NULL DEFAULT 'restricted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT players_account_status_check
    CHECK (account_status IN ('restricted', 'active', 'suspended', 'closed')),
  CONSTRAINT players_version_positive_check CHECK (version > 0),
  CONSTRAINT players_timestamp_order_check CHECK (updated_at >= created_at)
);

CREATE INDEX players_account_status_idx ON players (account_status);
CREATE INDEX players_created_at_idx ON players (created_at DESC);

CREATE TABLE authentication_identities (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT authentication_identities_provider_not_blank CHECK (BTRIM(provider) <> ''),
  CONSTRAINT authentication_identities_issuer_not_blank CHECK (BTRIM(issuer) <> ''),
  CONSTRAINT authentication_identities_subject_not_blank CHECK (BTRIM(subject) <> ''),
  CONSTRAINT authentication_identities_timestamp_order_check CHECK (last_seen_at >= created_at),
  CONSTRAINT authentication_identities_external_identity_unique
    UNIQUE (provider, issuer, subject)
);

CREATE INDEX authentication_identities_player_id_idx
  ON authentication_identities (player_id);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NULL,
  player_id UUID NULL REFERENCES players (id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT NULL,
  correlation_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audit_events_actor_type_not_blank CHECK (BTRIM(actor_type) <> ''),
  CONSTRAINT audit_events_action_not_blank CHECK (BTRIM(action) <> ''),
  CONSTRAINT audit_events_outcome_not_blank CHECK (BTRIM(outcome) <> ''),
  CONSTRAINT audit_events_correlation_id_not_blank CHECK (BTRIM(correlation_id) <> ''),
  CONSTRAINT audit_events_metadata_object_check CHECK (JSONB_TYPEOF(metadata) = 'object')
);

CREATE INDEX audit_events_player_created_idx
  ON audit_events (player_id, created_at DESC)
  WHERE player_id IS NOT NULL;
CREATE INDEX audit_events_action_created_idx
  ON audit_events (action, created_at DESC);
CREATE INDEX audit_events_correlation_id_idx
  ON audit_events (correlation_id);
CREATE INDEX audit_events_created_at_idx
  ON audit_events (created_at DESC);
