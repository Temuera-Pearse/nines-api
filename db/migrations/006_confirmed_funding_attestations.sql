ALTER TABLE crypto_funding_intents
  ADD COLUMN eligibility_decision_id UUID NULL REFERENCES eligibility_decisions (id) ON DELETE RESTRICT,
  ADD COLUMN eligibility_policy_version TEXT NULL,
  ADD COLUMN eligibility_evaluated_at TIMESTAMPTZ NULL,
  ADD CONSTRAINT crypto_funding_eligibility_shape CHECK (
    (eligibility_decision_id IS NULL AND eligibility_policy_version IS NULL AND eligibility_evaluated_at IS NULL)
    OR
    (eligibility_decision_id IS NOT NULL AND eligibility_policy_version IS NOT NULL AND eligibility_evaluated_at IS NOT NULL)
  );

CREATE INDEX crypto_funding_intents_eligibility_idx
  ON crypto_funding_intents (eligibility_decision_id)
  WHERE eligibility_decision_id IS NOT NULL;

ALTER TABLE financial_funding_instructions
  ADD COLUMN schema_version INTEGER NULL,
  ADD COLUMN event_type TEXT NULL,
  ADD COLUMN confirmation_event_id UUID NULL REFERENCES crypto_provider_events (id) ON DELETE RESTRICT,
  ADD COLUMN provider_confirmation_event_id TEXT NULL,
  ADD COLUMN external_atomic_units TEXT NULL,
  ADD COLUMN external_scale INTEGER NULL,
  ADD COLUMN eligibility_decision_id UUID NULL REFERENCES eligibility_decisions (id) ON DELETE RESTRICT,
  ADD COLUMN eligibility_policy_version TEXT NULL,
  ADD COLUMN eligibility_evaluated_at TIMESTAMPTZ NULL,
  ADD COLUMN issued_at TIMESTAMPTZ NULL,
  ADD COLUMN automatic_processing_until TIMESTAMPTZ NULL,
  ADD COLUMN correlation_id TEXT NULL,
  ADD COLUMN causation_id TEXT NULL,
  ADD COLUMN payload_hash TEXT NULL,
  ADD COLUMN attestation_payload JSONB NULL,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN lease_expires_at TIMESTAMPTZ NULL,
  ADD COLUMN lease_token UUID NULL,
  ADD COLUMN delivered_at TIMESTAMPTZ NULL,
  ADD COLUMN financial_consumption_id TEXT NULL,
  ADD COLUMN ledger_transaction_id TEXT NULL,
  ADD COLUMN last_error_code TEXT NULL;

ALTER TABLE financial_funding_instructions
  DROP CONSTRAINT financial_funding_delivery_check;

ALTER TABLE financial_funding_instructions
  ADD CONSTRAINT financial_funding_delivery_check CHECK (delivery_status IN (
    'pending', 'leased', 'retry_wait', 'acknowledged', 'review_required',
    'dead_letter', 'legacy_reconciliation_required', 'delivered', 'failed'
  )),
  ADD CONSTRAINT financial_funding_attestation_shape CHECK (
    schema_version IS NULL OR (
      schema_version = 1 AND event_type = 'external_funding_confirmed' AND
      confirmation_event_id IS NOT NULL AND provider_confirmation_event_id IS NOT NULL AND
      external_atomic_units ~ '^[1-9][0-9]*$' AND external_scale BETWEEN 0 AND 30 AND
      eligibility_decision_id IS NOT NULL AND eligibility_policy_version IS NOT NULL AND
      eligibility_evaluated_at IS NOT NULL AND issued_at IS NOT NULL AND
      automatic_processing_until > issued_at AND correlation_id IS NOT NULL AND
      causation_id IS NOT NULL AND payload_hash ~ '^[0-9a-f]{64}$' AND
      JSONB_TYPEOF(attestation_payload) = 'object'
    )
  ),
  ADD CONSTRAINT financial_funding_attempt_count_check CHECK (attempt_count >= 0),
  ADD CONSTRAINT financial_funding_delivery_ack_shape CHECK (
    delivery_status <> 'acknowledged' OR (
      delivered_at IS NOT NULL AND financial_consumption_id IS NOT NULL AND
      ledger_transaction_id IS NOT NULL
    )
  );

-- Phase 4 rows predate the signed v1 attestation and cannot be backfilled
-- without fabricating evidence. Preserve them explicitly for reconciliation
-- and exclude them from automatic delivery.
UPDATE financial_funding_instructions
SET delivery_status = 'legacy_reconciliation_required',
    next_attempt_at = NULL,
    lease_expires_at = NULL,
    lease_token = NULL,
    last_error_code = 'LEGACY_ATTESTATION_RECONCILIATION_REQUIRED'
WHERE schema_version IS NULL
  AND delivery_status IN ('pending', 'leased', 'retry_wait');

DROP INDEX financial_funding_delivery_idx;
CREATE INDEX financial_funding_delivery_idx
  ON financial_funding_instructions (delivery_status, next_attempt_at, created_at, id)
  WHERE delivery_status IN ('pending', 'leased', 'retry_wait');

CREATE TABLE financial_funding_delivery_attempts (
  id UUID PRIMARY KEY,
  funding_attestation_id UUID NOT NULL REFERENCES financial_funding_instructions (id) ON DELETE RESTRICT,
  request_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  response_status INTEGER NULL,
  error_code TEXT NULL,
  response_payload_hash TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT financial_delivery_attempt_number_check CHECK (attempt_number > 0),
  CONSTRAINT financial_delivery_attempt_outcome_check CHECK (
    outcome IN ('acknowledged', 'review_required', 'retryable_failure', 'permanent_failure')
  ),
  CONSTRAINT financial_delivery_attempt_time_check CHECK (completed_at >= started_at),
  CONSTRAINT financial_delivery_request_unique UNIQUE (request_id),
  CONSTRAINT financial_delivery_attestation_attempt_unique UNIQUE (funding_attestation_id, attempt_number)
);

CREATE INDEX financial_delivery_attempt_attestation_idx
  ON financial_funding_delivery_attempts (funding_attestation_id, attempt_number);

CREATE TABLE security_evidence_outbox (
  id UUID PRIMARY KEY,
  source_event_id UUID NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  funding_attestation_id UUID NOT NULL REFERENCES financial_funding_instructions (id) ON DELETE RESTRICT,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token UUID NULL,
  next_attempt_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ NULL,
  CONSTRAINT security_evidence_event_type_check CHECK (
    event_type IN ('api.external_funding_confirmed.v1', 'api.funding_delivery_failed.v1')
  ),
  CONSTRAINT security_evidence_payload_object CHECK (JSONB_TYPEOF(payload) = 'object'),
  CONSTRAINT security_evidence_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT security_evidence_delivery_check CHECK (
    delivery_status IN ('pending', 'retry_wait', 'delivered', 'dead_letter')
  ),
  CONSTRAINT security_evidence_attempt_check CHECK (attempt_count >= 0)
);

CREATE INDEX security_evidence_delivery_idx
  ON security_evidence_outbox (delivery_status, next_attempt_at, created_at, id)
  WHERE delivery_status IN ('pending', 'retry_wait');

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
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.schema_version IS DISTINCT FROM OLD.schema_version OR
     NEW.event_type IS DISTINCT FROM OLD.event_type OR
     NEW.confirmation_event_id IS DISTINCT FROM OLD.confirmation_event_id OR
     NEW.provider_confirmation_event_id IS DISTINCT FROM OLD.provider_confirmation_event_id OR
     NEW.external_atomic_units IS DISTINCT FROM OLD.external_atomic_units OR
     NEW.external_scale IS DISTINCT FROM OLD.external_scale OR
     NEW.eligibility_decision_id IS DISTINCT FROM OLD.eligibility_decision_id OR
     NEW.eligibility_policy_version IS DISTINCT FROM OLD.eligibility_policy_version OR
     NEW.eligibility_evaluated_at IS DISTINCT FROM OLD.eligibility_evaluated_at OR
     NEW.issued_at IS DISTINCT FROM OLD.issued_at OR
     NEW.automatic_processing_until IS DISTINCT FROM OLD.automatic_processing_until OR
     NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR
     NEW.causation_id IS DISTINCT FROM OLD.causation_id OR
     NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
     NEW.attestation_payload IS DISTINCT FROM OLD.attestation_payload
  THEN
    RAISE EXCEPTION 'financial funding attestation identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
