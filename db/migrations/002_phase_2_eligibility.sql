CREATE TABLE player_account_status_transitions (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT player_status_transition_from_check
    CHECK (from_status IN ('restricted', 'active', 'suspended', 'closed')),
  CONSTRAINT player_status_transition_to_check
    CHECK (to_status IN ('restricted', 'active', 'suspended', 'closed')),
  CONSTRAINT player_status_transition_changed_check CHECK (from_status <> to_status),
  CONSTRAINT player_status_transition_reason_not_blank CHECK (BTRIM(reason_code) <> ''),
  CONSTRAINT player_status_transition_actor_not_blank CHECK (BTRIM(actor_type) <> ''),
  CONSTRAINT player_status_transition_correlation_not_blank CHECK (BTRIM(correlation_id) <> '')
);

CREATE INDEX player_status_transitions_player_created_idx
  ON player_account_status_transitions (player_id, created_at DESC);

CREATE TABLE player_restrictions (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  restriction_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  reason_code TEXT NOT NULL,
  source TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT player_restrictions_type_check CHECK (
    restriction_type IN (
      'wagering_blocked',
      'deposits_blocked',
      'withdrawals_blocked',
      'security_review',
      'manual_review',
      'self_exclusion',
      'jurisdiction_blocked',
      'kyc_required'
    )
  ),
  CONSTRAINT player_restrictions_status_check
    CHECK (status IN ('active', 'removed', 'expired')),
  CONSTRAINT player_restrictions_reason_not_blank CHECK (BTRIM(reason_code) <> ''),
  CONSTRAINT player_restrictions_source_not_blank CHECK (BTRIM(source) <> ''),
  CONSTRAINT player_restrictions_time_order_check
    CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT player_restrictions_update_order_check CHECK (updated_at >= created_at),
  CONSTRAINT player_restrictions_metadata_object_check CHECK (JSONB_TYPEOF(metadata) = 'object')
);

CREATE INDEX player_restrictions_player_status_idx
  ON player_restrictions (player_id, status);
CREATE INDEX player_restrictions_expiry_idx
  ON player_restrictions (ends_at)
  WHERE status = 'active' AND ends_at IS NOT NULL;

CREATE TABLE eligibility_decisions (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  policy_version TEXT NOT NULL,
  input_snapshot JSONB NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eligibility_decisions_operation_check CHECK (
    operation IN (
      'view_races',
      'deposit',
      'withdraw',
      'place_wager',
      'start_kyc',
      'manage_profile'
    )
  ),
  CONSTRAINT eligibility_decisions_policy_not_blank CHECK (BTRIM(policy_version) <> ''),
  CONSTRAINT eligibility_decisions_correlation_not_blank CHECK (BTRIM(correlation_id) <> ''),
  CONSTRAINT eligibility_decisions_snapshot_object_check
    CHECK (JSONB_TYPEOF(input_snapshot) = 'object'),
  CONSTRAINT eligibility_decisions_allowed_reasons_check
    CHECK (allowed = (CARDINALITY(reason_codes) = 0)),
  CONSTRAINT eligibility_decisions_reason_codes_check CHECK (
    reason_codes <@ ARRAY[
      'ACCOUNT_RESTRICTED',
      'ACCOUNT_SUSPENDED',
      'ACCOUNT_CLOSED',
      'KYC_NOT_VERIFIED',
      'KYC_PENDING',
      'SECURITY_REVIEW',
      'SELF_EXCLUDED',
      'JURISDICTION_BLOCKED',
      'WAGERING_BLOCKED',
      'DEPOSITS_BLOCKED',
      'WITHDRAWALS_BLOCKED',
      'POLICY_DATA_INCOMPLETE'
    ]::TEXT[]
  )
);

CREATE INDEX eligibility_decisions_player_created_idx
  ON eligibility_decisions (player_id, created_at DESC);
CREATE INDEX eligibility_decisions_correlation_idx
  ON eligibility_decisions (correlation_id);

CREATE OR REPLACE FUNCTION reject_phase_2_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER player_status_transitions_append_only
  BEFORE UPDATE OR DELETE ON player_account_status_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_phase_2_history_mutation();

CREATE TRIGGER eligibility_decisions_append_only
  BEFORE UPDATE OR DELETE ON eligibility_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_phase_2_history_mutation();
