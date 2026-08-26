ALTER TABLE kyc_provider_events
  ADD COLUMN claimed_player_reference TEXT NULL,
  ADD COLUMN accepted_at TIMESTAMPTZ NULL;

UPDATE kyc_provider_events
SET accepted_at = processed_at
WHERE processing_status = 'processed';

ALTER TABLE kyc_provider_events
  DROP CONSTRAINT kyc_provider_events_processing_status_check,
  ADD CONSTRAINT kyc_provider_events_processing_status_check CHECK (
    processing_status IN (
      'received',
      'processed',
      'ignored_duplicate',
      'ignored_stale',
      'ignored_expired',
      'rejected'
    )
  ),
  ADD CONSTRAINT kyc_provider_events_accepted_order_check
    CHECK (accepted_at IS NULL OR accepted_at >= received_at),
  ADD CONSTRAINT kyc_provider_events_acceptance_shape_check
    CHECK (accepted_at IS NULL OR processing_status = 'processed');

ALTER TABLE kyc_status_transitions
  ADD COLUMN kyc_profile_id UUID NULL REFERENCES player_kyc_profiles (id) ON DELETE RESTRICT,
  ADD COLUMN transition_trigger TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN policy_version TEXT NULL,
  ADD COLUMN profile_version INTEGER NULL;

ALTER TABLE kyc_status_transitions
  DISABLE TRIGGER kyc_status_transitions_append_only;

UPDATE kyc_status_transitions AS transition
SET kyc_profile_id = profile.id,
    reason_codes = ARRAY[transition.reason_code]
FROM player_kyc_profiles AS profile
WHERE profile.player_id = transition.player_id;

UPDATE kyc_status_transitions
SET metadata = metadata || jsonb_build_object('legacyActorType', actor_type)
WHERE actor_type NOT IN (
  'PLAYER', 'external_identity', 'PROVIDER', 'fake_provider', 'SYSTEM', 'ADMIN'
);

UPDATE kyc_status_transitions
SET actor_type = CASE
  WHEN actor_type IN ('PLAYER', 'external_identity') THEN 'PLAYER'
  WHEN actor_type IN ('PROVIDER', 'fake_provider') THEN 'PROVIDER'
  WHEN actor_type = 'SYSTEM' THEN 'SYSTEM'
  WHEN actor_type = 'ADMIN' THEN 'ADMIN'
  ELSE 'SYSTEM'
END;

ALTER TABLE kyc_status_transitions
  ENABLE TRIGGER kyc_status_transitions_append_only;

ALTER TABLE kyc_status_transitions
  ALTER COLUMN kyc_profile_id SET NOT NULL,
  ADD CONSTRAINT kyc_transitions_trigger_not_blank
    CHECK (BTRIM(transition_trigger) <> ''),
  ADD CONSTRAINT kyc_transitions_reason_codes_not_empty
    CHECK (CARDINALITY(reason_codes) > 0),
  ADD CONSTRAINT kyc_transitions_reason_codes_not_blank
    CHECK (array_position(reason_codes, '') IS NULL),
  ADD CONSTRAINT kyc_transitions_actor_type_check
    CHECK (actor_type IN ('PLAYER', 'ADMIN', 'PROVIDER', 'SYSTEM')),
  ADD CONSTRAINT kyc_transitions_profile_version_positive
    CHECK (profile_version IS NULL OR profile_version > 0);

CREATE INDEX kyc_transitions_profile_created_idx
  ON kyc_status_transitions (kyc_profile_id, created_at DESC);

CREATE INDEX player_kyc_profiles_verified_expiry_idx
  ON player_kyc_profiles (expires_at, id)
  WHERE status = 'verified' AND expires_at IS NOT NULL;

CREATE TABLE kyc_manual_reviews (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  kyc_profile_id UUID NOT NULL REFERENCES player_kyc_profiles (id) ON DELETE RESTRICT,
  session_id UUID NULL REFERENCES kyc_verification_sessions (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'requested',
  assigned_actor_id TEXT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  opened_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kyc_manual_reviews_status_check
    CHECK (status IN ('requested', 'open', 'assigned', 'completed')),
  CONSTRAINT kyc_manual_reviews_actor_not_blank
    CHECK (assigned_actor_id IS NULL OR BTRIM(assigned_actor_id) <> ''),
  CONSTRAINT kyc_manual_reviews_opened_order_check
    CHECK (opened_at IS NULL OR opened_at >= requested_at),
  CONSTRAINT kyc_manual_reviews_completed_order_check
    CHECK (completed_at IS NULL OR completed_at >= requested_at),
  CONSTRAINT kyc_manual_reviews_completion_shape_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL) OR
    (status <> 'completed' AND completed_at IS NULL)
  ),
  CONSTRAINT kyc_manual_reviews_timestamp_order_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX kyc_manual_reviews_one_active_profile_idx
  ON kyc_manual_reviews (kyc_profile_id)
  WHERE status <> 'completed';
CREATE INDEX kyc_manual_reviews_player_created_idx
  ON kyc_manual_reviews (player_id, created_at DESC);
CREATE INDEX kyc_manual_reviews_status_created_idx
  ON kyc_manual_reviews (status, created_at);

CREATE TABLE kyc_manual_review_actions (
  id UUID PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES kyc_manual_reviews (id) ON DELETE RESTRICT,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  kyc_profile_id UUID NOT NULL REFERENCES player_kyc_profiles (id) ON DELETE RESTRICT,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NULL,
  reason_codes TEXT[] NOT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kyc_manual_review_actions_status_check CHECK (
    previous_status IN ('not_started', 'pending', 'verified', 'failed', 'manual_review', 'expired') AND
    new_status IN ('not_started', 'pending', 'verified', 'failed', 'manual_review', 'expired')
  ),
  CONSTRAINT kyc_manual_review_actions_action_not_blank CHECK (BTRIM(action) <> ''),
  CONSTRAINT kyc_manual_review_actions_actor_type_check
    CHECK (actor_type IN ('PLAYER', 'ADMIN', 'PROVIDER', 'SYSTEM')),
  CONSTRAINT kyc_manual_review_actions_actor_id_not_blank
    CHECK (actor_id IS NULL OR BTRIM(actor_id) <> ''),
  CONSTRAINT kyc_manual_review_actions_reason_codes_not_empty
    CHECK (CARDINALITY(reason_codes) > 0),
  CONSTRAINT kyc_manual_review_actions_reason_codes_not_blank
    CHECK (array_position(reason_codes, '') IS NULL),
  CONSTRAINT kyc_manual_review_actions_notes_length
    CHECK (notes IS NULL OR CHAR_LENGTH(notes) <= 2000)
);

CREATE INDEX kyc_manual_review_actions_review_created_idx
  ON kyc_manual_review_actions (review_id, created_at, id);
CREATE INDEX kyc_manual_review_actions_player_created_idx
  ON kyc_manual_review_actions (player_id, created_at DESC);

INSERT INTO kyc_manual_reviews
  (id, player_id, kyc_profile_id, session_id, status, requested_at,
   opened_at, created_at, updated_at)
SELECT
  md5(profile.id::text || ':phase-3.5-review')::uuid,
  profile.player_id,
  profile.id,
  profile.current_session_id,
  'open',
  profile.updated_at,
  profile.updated_at,
  profile.updated_at,
  profile.updated_at
FROM player_kyc_profiles AS profile
WHERE profile.status = 'manual_review';

INSERT INTO kyc_manual_review_actions
  (id, review_id, player_id, kyc_profile_id, previous_status, new_status,
   action, actor_type, actor_id, reason_codes, notes, created_at)
SELECT
  md5(profile.id::text || ':phase-3.5-review-action')::uuid,
  review.id,
  profile.player_id,
  profile.id,
  'pending',
  'manual_review',
  'review_backfilled',
  'SYSTEM',
  'phase_3_5_migration',
  ARRAY['KYC_MANUAL_REVIEW_REQUESTED'],
  NULL,
  profile.updated_at
FROM player_kyc_profiles AS profile
JOIN kyc_manual_reviews AS review ON review.kyc_profile_id = profile.id
WHERE profile.status = 'manual_review';

CREATE OR REPLACE FUNCTION reject_kyc_manual_review_action_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'kyc_manual_review_actions is append only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER kyc_manual_review_actions_append_only
  BEFORE UPDATE OR DELETE ON kyc_manual_review_actions
  FOR EACH ROW EXECUTE FUNCTION reject_kyc_manual_review_action_mutation();

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
    NEW.claimed_player_reference IS DISTINCT FROM OLD.claimed_player_reference OR
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

CREATE OR REPLACE FUNCTION enforce_kyc_profile_transition_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
    FROM kyc_status_transitions AS transition
    WHERE transition.kyc_profile_id = NEW.id
      AND transition.profile_version = NEW.version
      AND transition.from_status = OLD.status
      AND transition.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'KYC profile status change requires a matching transition record'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER player_kyc_profiles_transition_required
  AFTER UPDATE OF status ON player_kyc_profiles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_kyc_profile_transition_record();
