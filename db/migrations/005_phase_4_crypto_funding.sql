CREATE TABLE crypto_funding_intents (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  asset TEXT NOT NULL,
  requested_amount TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  provider_reference TEXT NULL,
  payment_url TEXT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NULL,
  failed_at TIMESTAMPTZ NULL,
  last_provider_event_at TIMESTAMPTZ NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT crypto_funding_asset_check CHECK (asset ~ '^[A-Z][A-Z0-9]{1,11}$'),
  CONSTRAINT crypto_funding_amount_check CHECK (
    LENGTH(requested_amount) <= 96 AND
    requested_amount ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
    AND requested_amount !~ '^0(\.0+)?$'
  ),
  CONSTRAINT crypto_funding_status_check CHECK (status IN (
    'provider_pending', 'awaiting_payment', 'detected', 'confirming', 'confirmed',
    'failed', 'expired', 'reconciliation_required', 'creation_failed'
  )),
  CONSTRAINT crypto_funding_provider_not_blank CHECK (BTRIM(provider) <> '' AND LENGTH(provider) <= 64),
  CONSTRAINT crypto_funding_idempotency_not_blank CHECK (BTRIM(idempotency_key) <> '' AND LENGTH(idempotency_key) <= 128),
  CONSTRAINT crypto_funding_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT crypto_funding_reference_not_blank CHECK (provider_reference IS NULL OR (BTRIM(provider_reference) <> '' AND LENGTH(provider_reference) <= 256)),
  CONSTRAINT crypto_funding_payment_url_bounded CHECK (payment_url IS NULL OR LENGTH(payment_url) <= 2048),
  CONSTRAINT crypto_funding_version_positive CHECK (version > 0),
  CONSTRAINT crypto_funding_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT crypto_funding_confirmed_shape CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CONSTRAINT crypto_funding_failed_shape CHECK (status NOT IN ('failed', 'creation_failed') OR failed_at IS NOT NULL),
  CONSTRAINT crypto_funding_timestamp_order CHECK (updated_at >= created_at),
  CONSTRAINT crypto_funding_player_idempotency_unique UNIQUE (player_id, idempotency_key),
  CONSTRAINT crypto_funding_provider_reference_unique UNIQUE (provider, provider_reference)
);

CREATE INDEX crypto_funding_player_created_idx ON crypto_funding_intents (player_id, created_at DESC, id DESC);
CREATE INDEX crypto_funding_expiry_idx ON crypto_funding_intents (expires_at, id)
  WHERE status IN ('provider_pending', 'awaiting_payment', 'detected', 'confirming');

CREATE TABLE crypto_funding_provider_sessions (
  id UUID PRIMARY KEY,
  funding_intent_id UUID NOT NULL UNIQUE REFERENCES crypto_funding_intents (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_idempotency_key UUID NOT NULL UNIQUE,
  provider_reference TEXT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT crypto_provider_session_status_check CHECK (status IN ('creating', 'active', 'creation_failed')),
  CONSTRAINT crypto_provider_session_provider_not_blank CHECK (BTRIM(provider) <> '' AND LENGTH(provider) <= 64),
  CONSTRAINT crypto_provider_session_reference_not_blank CHECK (provider_reference IS NULL OR (BTRIM(provider_reference) <> '' AND LENGTH(provider_reference) <= 256)),
  CONSTRAINT crypto_provider_session_reference_unique UNIQUE (provider, provider_reference),
  CONSTRAINT crypto_provider_session_idempotency_matches_intent CHECK (provider_idempotency_key = funding_intent_id)
);

CREATE TABLE crypto_provider_events (
  id UUID PRIMARY KEY,
  funding_intent_id UUID NULL REFERENCES crypto_funding_intents (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_reference TEXT NOT NULL,
  claimed_funding_intent_id TEXT NULL,
  claimed_player_id TEXT NULL,
  event_type TEXT NOT NULL,
  normalized_status TEXT NOT NULL,
  provider_occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  processed_at TIMESTAMPTZ NULL,
  asset TEXT NULL,
  amount TEXT NULL,
  payload_hash TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received',
  processing_reason_code TEXT NULL,
  correlation_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT crypto_events_identity_unique UNIQUE (provider, provider_event_id),
  CONSTRAINT crypto_events_provider_not_blank CHECK (BTRIM(provider) <> '' AND LENGTH(provider) <= 64),
  CONSTRAINT crypto_events_provider_event_id_check CHECK (BTRIM(provider_event_id) <> '' AND LENGTH(provider_event_id) <= 128),
  CONSTRAINT crypto_events_provider_reference_check CHECK (BTRIM(provider_reference) <> '' AND LENGTH(provider_reference) <= 256),
  CONSTRAINT crypto_events_event_type_check CHECK (BTRIM(event_type) <> '' AND LENGTH(event_type) <= 128),
  CONSTRAINT crypto_events_status_check CHECK (normalized_status IN ('payment_detected', 'confirming', 'confirmed', 'failed', 'expired')),
  CONSTRAINT crypto_events_asset_check CHECK (asset IS NULL OR asset ~ '^[A-Z][A-Z0-9]{1,11}$'),
  CONSTRAINT crypto_events_amount_check CHECK (
    amount IS NULL OR (
      LENGTH(amount) <= 96 AND
      amount ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
      AND amount !~ '^0(\.0+)?$'
    )
  ),
  CONSTRAINT crypto_events_processing_check CHECK (processing_status IN ('received', 'processed', 'ignored_duplicate', 'ignored_stale', 'ignored_expired', 'rejected')),
  CONSTRAINT crypto_events_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT crypto_events_processing_shape CHECK (
    (processing_status = 'received' AND processed_at IS NULL) OR
    (processing_status <> 'received' AND processed_at IS NOT NULL)
  ),
  CONSTRAINT crypto_events_acceptance_shape CHECK (accepted_at IS NULL OR processing_status = 'processed'),
  CONSTRAINT crypto_events_accepted_order CHECK (accepted_at IS NULL OR accepted_at >= received_at),
  CONSTRAINT crypto_events_metadata_object CHECK (JSONB_TYPEOF(metadata) = 'object')
);

CREATE INDEX crypto_events_reference_time_idx ON crypto_provider_events (provider, provider_reference, provider_occurred_at DESC);
CREATE INDEX crypto_events_intent_received_idx ON crypto_provider_events (funding_intent_id, received_at DESC) WHERE funding_intent_id IS NOT NULL;

CREATE TABLE crypto_funding_transitions (
  id UUID PRIMARY KEY,
  funding_intent_id UUID NOT NULL REFERENCES crypto_funding_intents (id) ON DELETE RESTRICT,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NULL,
  provider_event_id UUID NULL REFERENCES crypto_provider_events (id) ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL,
  intent_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT crypto_transitions_status_check CHECK (
    from_status IN (
      'provider_pending', 'awaiting_payment', 'detected', 'confirming', 'confirmed',
      'failed', 'expired', 'reconciliation_required', 'creation_failed'
    ) AND to_status IN (
      'provider_pending', 'awaiting_payment', 'detected', 'confirming', 'confirmed',
      'failed', 'expired', 'reconciliation_required', 'creation_failed'
    )
  ),
  CONSTRAINT crypto_transitions_changed CHECK (from_status <> to_status),
  CONSTRAINT crypto_transitions_actor_check CHECK (actor_type IN ('PLAYER', 'PROVIDER', 'SYSTEM', 'ADMIN')),
  CONSTRAINT crypto_transitions_version_positive CHECK (intent_version > 0)
);

CREATE INDEX crypto_transitions_intent_created_idx ON crypto_funding_transitions (funding_intent_id, created_at, id);

CREATE TABLE financial_funding_instructions (
  id UUID PRIMARY KEY,
  funding_intent_id UUID NOT NULL UNIQUE REFERENCES crypto_funding_intents (id) ON DELETE RESTRICT,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'CRYPTO',
  asset TEXT NOT NULL,
  external_amount TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_reference TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_funding_source_check CHECK (source = 'CRYPTO'),
  CONSTRAINT financial_funding_asset_check CHECK (asset ~ '^[A-Z][A-Z0-9]{1,11}$'),
  CONSTRAINT financial_funding_amount_check CHECK (
    LENGTH(external_amount) <= 96 AND
    external_amount ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
    AND external_amount !~ '^0(\.0+)?$'
  ),
  CONSTRAINT financial_funding_provider_check CHECK (BTRIM(provider) <> '' AND LENGTH(provider) <= 64),
  CONSTRAINT financial_funding_reference_check CHECK (BTRIM(provider_reference) <> '' AND LENGTH(provider_reference) <= 256),
  CONSTRAINT financial_funding_delivery_check CHECK (delivery_status IN ('pending', 'delivered', 'failed'))
);

CREATE INDEX financial_funding_delivery_idx ON financial_funding_instructions (delivery_status, created_at, id);

CREATE TABLE crypto_funding_reconciliations (
  id UUID PRIMARY KEY,
  funding_intent_id UUID NULL REFERENCES crypto_funding_intents (id) ON DELETE RESTRICT,
  provider_event_id UUID NULL REFERENCES crypto_provider_events (id) ON DELETE RESTRICT,
  discrepancy_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  expected_asset TEXT NULL,
  actual_asset TEXT NULL,
  expected_amount TEXT NULL,
  actual_amount TEXT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ NULL,
  CONSTRAINT crypto_reconciliation_type_check CHECK (discrepancy_type IN (
    'UNDERPAID', 'OVERPAID', 'ASSET_MISMATCH', 'AMOUNT_UNDETERMINED',
    'PAYMENT_AFTER_EXPIRY', 'PAYMENT_ON_TERMINAL_INTENT', 'UNKNOWN_PROVIDER_REFERENCE',
    'FINANCIAL_INSTRUCTION_MISSING', 'INTENT_EXPIRED_AFTER_PAYMENT_DETECTED'
  )),
  CONSTRAINT crypto_reconciliation_status_check CHECK (status IN ('open', 'resolved')),
  CONSTRAINT crypto_reconciliation_expected_asset_check CHECK (expected_asset IS NULL OR expected_asset ~ '^[A-Z][A-Z0-9]{1,11}$'),
  CONSTRAINT crypto_reconciliation_actual_asset_check CHECK (actual_asset IS NULL OR actual_asset ~ '^[A-Z][A-Z0-9]{1,11}$'),
  CONSTRAINT crypto_reconciliation_expected_amount_check CHECK (
    expected_amount IS NULL OR expected_amount ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
  ),
  CONSTRAINT crypto_reconciliation_actual_amount_check CHECK (
    actual_amount IS NULL OR actual_amount ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
  ),
  CONSTRAINT crypto_reconciliation_resolution_shape CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX crypto_reconciliation_event_type_unique
  ON crypto_funding_reconciliations (provider_event_id, discrepancy_type)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX crypto_reconciliation_open_idx ON crypto_funding_reconciliations (created_at, id) WHERE status = 'open';

CREATE OR REPLACE FUNCTION reject_crypto_history_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER crypto_funding_transitions_append_only
  BEFORE UPDATE OR DELETE ON crypto_funding_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_crypto_history_mutation();

CREATE OR REPLACE FUNCTION protect_financial_funding_instruction()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'financial_funding_instructions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.funding_intent_id IS DISTINCT FROM OLD.funding_intent_id OR
     NEW.player_id IS DISTINCT FROM OLD.player_id OR
     NEW.source IS DISTINCT FROM OLD.source OR
     NEW.asset IS DISTINCT FROM OLD.asset OR
     NEW.external_amount IS DISTINCT FROM OLD.external_amount OR
     NEW.provider IS DISTINCT FROM OLD.provider OR
     NEW.provider_reference IS DISTINCT FROM OLD.provider_reference OR
     NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'financial funding instruction identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_funding_instruction_immutable
  BEFORE UPDATE OR DELETE ON financial_funding_instructions
  FOR EACH ROW EXECUTE FUNCTION protect_financial_funding_instruction();

CREATE OR REPLACE FUNCTION protect_crypto_provider_event_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'crypto_provider_events cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.provider IS DISTINCT FROM OLD.provider OR
     NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR
     NEW.provider_reference IS DISTINCT FROM OLD.provider_reference OR
     NEW.claimed_funding_intent_id IS DISTINCT FROM OLD.claimed_funding_intent_id OR
     NEW.claimed_player_id IS DISTINCT FROM OLD.claimed_player_id OR
     NEW.event_type IS DISTINCT FROM OLD.event_type OR
     NEW.normalized_status IS DISTINCT FROM OLD.normalized_status OR
     NEW.provider_occurred_at IS DISTINCT FROM OLD.provider_occurred_at OR
     NEW.asset IS DISTINCT FROM OLD.asset OR NEW.amount IS DISTINCT FROM OLD.amount OR
     NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
     NEW.received_at IS DISTINCT FROM OLD.received_at OR
     NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR
     NEW.metadata IS DISTINCT FROM OLD.metadata
  THEN
    RAISE EXCEPTION 'crypto provider event identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.processing_status <> 'received' AND (
     NEW.funding_intent_id IS DISTINCT FROM OLD.funding_intent_id OR
     NEW.processing_status IS DISTINCT FROM OLD.processing_status OR
     NEW.processing_reason_code IS DISTINCT FROM OLD.processing_reason_code OR
     NEW.processed_at IS DISTINCT FROM OLD.processed_at OR
     NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
  ) THEN
    RAISE EXCEPTION 'crypto provider event outcome is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crypto_provider_event_identity_immutable
  BEFORE UPDATE OR DELETE ON crypto_provider_events
  FOR EACH ROW EXECUTE FUNCTION protect_crypto_provider_event_identity();

CREATE OR REPLACE FUNCTION enforce_crypto_funding_transition_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
    FROM crypto_funding_transitions AS transition
    WHERE transition.funding_intent_id = NEW.id
      AND transition.player_id = NEW.player_id
      AND transition.intent_version = NEW.version
      AND transition.from_status = OLD.status
      AND transition.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'Crypto funding status change requires a matching transition record'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER crypto_funding_intents_transition_required
  AFTER UPDATE OF status ON crypto_funding_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_crypto_funding_transition_record();

CREATE OR REPLACE FUNCTION enforce_confirmed_crypto_funding_instruction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'confirmed' AND NOT EXISTS (
    SELECT 1
    FROM financial_funding_instructions AS instruction
    WHERE instruction.funding_intent_id = NEW.id
      AND instruction.player_id = NEW.player_id
      AND instruction.asset = NEW.asset
      AND instruction.external_amount = NEW.requested_amount
      AND instruction.provider = NEW.provider
      AND instruction.provider_reference = NEW.provider_reference
      AND instruction.confirmed_at = NEW.confirmed_at
  ) THEN
    RAISE EXCEPTION 'Confirmed crypto funding requires a matching financial instruction'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER confirmed_crypto_funding_instruction_required
  AFTER UPDATE OF status ON crypto_funding_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_confirmed_crypto_funding_instruction();

CREATE CONSTRAINT TRIGGER confirmed_crypto_funding_instruction_required_on_insert
  AFTER INSERT ON crypto_funding_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_confirmed_crypto_funding_instruction();
