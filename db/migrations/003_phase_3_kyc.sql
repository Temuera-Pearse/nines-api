CREATE TABLE player_kyc_profiles (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL UNIQUE REFERENCES players (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'not_started',
  provider TEXT NULL,
  current_session_id UUID NULL,
  verified_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  failure_reason_code TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT player_kyc_profiles_status_check CHECK (
    status IN ('not_started', 'pending', 'verified', 'failed', 'manual_review', 'expired')
  ),
  CONSTRAINT player_kyc_profiles_version_check CHECK (version > 0),
  CONSTRAINT player_kyc_profiles_provider_not_blank
    CHECK (provider IS NULL OR BTRIM(provider) <> ''),
  CONSTRAINT player_kyc_profiles_failure_reason_not_blank
    CHECK (failure_reason_code IS NULL OR BTRIM(failure_reason_code) <> ''),
  CONSTRAINT player_kyc_profiles_verified_state_check
    CHECK (status <> 'verified' OR verified_at IS NOT NULL),
  CONSTRAINT player_kyc_profiles_not_started_shape_check CHECK (
    status <> 'not_started' OR (
      provider IS NULL AND
      current_session_id IS NULL AND
      verified_at IS NULL AND
      expires_at IS NULL AND
      failure_reason_code IS NULL
    )
  ),
  CONSTRAINT player_kyc_profiles_active_shape_check CHECK (
    status NOT IN ('pending', 'manual_review') OR
    (provider IS NOT NULL AND current_session_id IS NOT NULL)
  ),
  CONSTRAINT player_kyc_profiles_failed_reason_check
    CHECK (status <> 'failed' OR failure_reason_code IS NOT NULL),
  CONSTRAINT player_kyc_profiles_expiry_order_check
    CHECK (expires_at IS NULL OR verified_at IS NULL OR expires_at >= verified_at),
  CONSTRAINT player_kyc_profiles_timestamp_order_check CHECK (updated_at >= created_at)
);

CREATE TABLE kyc_verification_sessions (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_session_reference TEXT NULL,
  verification_url TEXT NULL,
  idempotency_key TEXT NULL,
  status TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  last_event_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kyc_sessions_provider_not_blank CHECK (BTRIM(provider) <> ''),
  CONSTRAINT kyc_sessions_provider_reference_not_blank
    CHECK (provider_session_reference IS NULL OR BTRIM(provider_session_reference) <> ''),
  CONSTRAINT kyc_sessions_idempotency_not_blank
    CHECK (idempotency_key IS NULL OR BTRIM(idempotency_key) <> ''),
  CONSTRAINT kyc_sessions_status_check CHECK (
    status IN (
      'creating',
      'pending',
      'verified',
      'failed',
      'manual_review',
      'expired',
      'creation_failed'
    )
  ),
  CONSTRAINT kyc_sessions_attempt_positive_check CHECK (attempt_number > 0),
  CONSTRAINT kyc_sessions_expiry_order_check
    CHECK (expires_at IS NULL OR expires_at > started_at),
  CONSTRAINT kyc_sessions_completed_order_check
    CHECK (completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT kyc_sessions_event_order_check
    CHECK (last_event_at IS NULL OR last_event_at >= started_at),
  CONSTRAINT kyc_sessions_timestamp_order_check CHECK (updated_at >= created_at),
  CONSTRAINT kyc_sessions_initialized_shape_check CHECK (
    status IN ('creating', 'creation_failed') OR
    (provider_session_reference IS NOT NULL AND expires_at IS NOT NULL)
  ),
  CONSTRAINT kyc_sessions_terminal_shape_check CHECK (
    status NOT IN ('verified', 'failed', 'expired') OR completed_at IS NOT NULL
  ),
  CONSTRAINT kyc_sessions_active_completion_check CHECK (
    status NOT IN ('creating', 'pending', 'manual_review') OR completed_at IS NULL
  ),
  CONSTRAINT kyc_sessions_provider_reference_unique
    UNIQUE (provider, provider_session_reference),
  CONSTRAINT kyc_sessions_player_idempotency_unique
    UNIQUE (player_id, idempotency_key)
);

CREATE UNIQUE INDEX kyc_sessions_one_effective_active_idx
  ON kyc_verification_sessions (player_id)
  WHERE status IN ('creating', 'pending', 'manual_review');
CREATE INDEX kyc_sessions_player_attempt_idx
  ON kyc_verification_sessions (player_id, attempt_number DESC);
CREATE INDEX kyc_sessions_expiry_idx
  ON kyc_verification_sessions (expires_at)
  WHERE status = 'pending' AND expires_at IS NOT NULL;

ALTER TABLE player_kyc_profiles
  ADD CONSTRAINT player_kyc_profiles_current_session_fk
  FOREIGN KEY (current_session_id)
  REFERENCES kyc_verification_sessions (id)
  ON DELETE RESTRICT;

CREATE TABLE kyc_provider_events (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_session_reference TEXT NOT NULL,
  event_type TEXT NOT NULL,
  normalized_status TEXT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  payload_hash TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received',
  processing_reason_code TEXT NULL,
  correlation_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT kyc_provider_events_provider_not_blank CHECK (BTRIM(provider) <> ''),
  CONSTRAINT kyc_provider_events_event_id_not_blank CHECK (BTRIM(provider_event_id) <> ''),
  CONSTRAINT kyc_provider_events_session_reference_not_blank
    CHECK (BTRIM(provider_session_reference) <> ''),
  CONSTRAINT kyc_provider_events_event_type_not_blank CHECK (BTRIM(event_type) <> ''),
  CONSTRAINT kyc_provider_events_payload_hash_check
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT kyc_provider_events_normalized_status_check CHECK (
    normalized_status IS NULL OR
    normalized_status IN ('pending', 'verified', 'failed', 'manual_review', 'expired')
  ),
  CONSTRAINT kyc_provider_events_processing_status_check CHECK (
    processing_status IN (
      'received',
      'processed',
      'ignored_duplicate',
      'ignored_stale',
      'rejected'
    )
  ),
  CONSTRAINT kyc_provider_events_reason_not_blank
    CHECK (processing_reason_code IS NULL OR BTRIM(processing_reason_code) <> ''),
  CONSTRAINT kyc_provider_events_correlation_not_blank CHECK (BTRIM(correlation_id) <> ''),
  CONSTRAINT kyc_provider_events_processed_order_check
    CHECK (processed_at IS NULL OR processed_at >= received_at),
  CONSTRAINT kyc_provider_events_processing_shape_check CHECK (
    (processing_status = 'received' AND processed_at IS NULL) OR
    (processing_status <> 'received' AND processed_at IS NOT NULL)
  ),
  CONSTRAINT kyc_provider_events_metadata_object_check CHECK (JSONB_TYPEOF(metadata) = 'object'),
  CONSTRAINT kyc_provider_events_provider_event_unique UNIQUE (provider, provider_event_id)
);

CREATE INDEX kyc_provider_events_session_idx
  ON kyc_provider_events (provider, provider_session_reference, event_timestamp DESC);
CREATE INDEX kyc_provider_events_correlation_idx
  ON kyc_provider_events (correlation_id);
CREATE INDEX kyc_provider_events_received_idx
  ON kyc_provider_events (received_at DESC);

CREATE TABLE kyc_status_transitions (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  session_id UUID NULL REFERENCES kyc_verification_sessions (id) ON DELETE RESTRICT,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NULL,
  provider_event_id UUID NULL REFERENCES kyc_provider_events (id) ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kyc_transitions_from_status_check CHECK (
    from_status IN ('not_started', 'pending', 'verified', 'failed', 'manual_review', 'expired')
  ),
  CONSTRAINT kyc_transitions_to_status_check CHECK (
    to_status IN ('not_started', 'pending', 'verified', 'failed', 'manual_review', 'expired')
  ),
  CONSTRAINT kyc_transitions_changed_check CHECK (from_status <> to_status),
  CONSTRAINT kyc_transitions_reason_not_blank CHECK (BTRIM(reason_code) <> ''),
  CONSTRAINT kyc_transitions_actor_not_blank CHECK (BTRIM(actor_type) <> ''),
  CONSTRAINT kyc_transitions_correlation_not_blank CHECK (BTRIM(correlation_id) <> ''),
  CONSTRAINT kyc_transitions_metadata_object_check CHECK (JSONB_TYPEOF(metadata) = 'object')
);

CREATE INDEX kyc_transitions_player_created_idx
  ON kyc_status_transitions (player_id, created_at DESC);
CREATE INDEX kyc_transitions_session_created_idx
  ON kyc_status_transitions (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX kyc_transitions_correlation_idx
  ON kyc_status_transitions (correlation_id);
CREATE INDEX kyc_transitions_created_idx
  ON kyc_status_transitions (created_at DESC);

CREATE OR REPLACE FUNCTION reject_kyc_transition_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'kyc_status_transitions is append only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER kyc_status_transitions_append_only
  BEFORE UPDATE OR DELETE ON kyc_status_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_kyc_transition_mutation();

CREATE OR REPLACE FUNCTION protect_kyc_provider_event_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'kyc_provider_events cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.provider IS DISTINCT FROM OLD.provider OR
    NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR
    NEW.provider_session_reference IS DISTINCT FROM OLD.provider_session_reference OR
    NEW.event_type IS DISTINCT FROM OLD.event_type OR
    NEW.normalized_status IS DISTINCT FROM OLD.normalized_status OR
    NEW.event_timestamp IS DISTINCT FROM OLD.event_timestamp OR
    NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
    NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR
    NEW.received_at IS DISTINCT FROM OLD.received_at OR
    NEW.metadata IS DISTINCT FROM OLD.metadata
  THEN
    RAISE EXCEPTION 'kyc_provider_event identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kyc_provider_event_identity_immutable
  BEFORE UPDATE OR DELETE ON kyc_provider_events
  FOR EACH ROW EXECUTE FUNCTION protect_kyc_provider_event_identity();
