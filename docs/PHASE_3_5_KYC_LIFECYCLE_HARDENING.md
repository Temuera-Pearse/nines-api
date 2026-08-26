# Phase 3.5 — KYC lifecycle hardening

This phase completes the provider-neutral KYC lifecycle. It does not add a real
identity provider, money movement, wagering, race, or cryptocurrency behavior.

## Authoritative transition mechanism

`TransitionKycStatusService` is the only active application component allowed
to update `player_kyc_profiles.status`. It locks the profile, validates the
transition, applies the optimistic version update, appends immutable transition
and audit records, maintains the associated manual-review workflow, and returns
the new profile in the caller's transaction.

Migration `004_phase_3_5_kyc_lifecycle_hardening.sql` adds a deferred database
constraint trigger. A transaction that changes profile status cannot commit
unless it also contains a matching transition for the profile's new version.
Invalid application transitions return `KYC_INVALID_STATE_TRANSITION`.

The existing status vocabulary is retained:

| Current | Allowed next statuses |
|---|---|
| `not_started` | `pending` |
| `pending` | `verified`, `failed`, `manual_review`, `expired` |
| `manual_review` | `verified`, `failed`, `pending`, `expired` |
| `verified` | `expired`, `manual_review` |
| `failed` | `pending` |
| `expired` | `pending` |

`pending`, `verified`, and `failed` are the current-domain equivalents of in
progress, approved, and rejected. No-op transitions are invalid.

Every accepted transition records the KYC profile and player IDs, previous and
new status, trigger, canonical actor type (`PLAYER`, `ADMIN`, `PROVIDER`, or
`SYSTEM`), optional actor ID, provider and provider-event references, reason-code
array, eligibility policy version, profile version, correlation ID, and time.
Transition records remain append-only and contain no documents or raw provider
payloads.

## Provider-event processing

The database unique constraint on `(provider, provider_event_id)` is the
idempotency boundary. `INSERT ... ON CONFLICT DO NOTHING` makes concurrent
duplicate deliveries converge on one stored event. An identical duplicate is
acknowledged as `ignored_duplicate` and causes no second state transition.
Reusing the identity with a different payload hash, session, or type returns
`KYC_PROVIDER_EVENT_IDENTITY_CONFLICT`. The collision transaction commits a
rejected security audit before the public 409 is mapped, so the evidence is not
lost to rollback.

The processor locks the provider-scoped session before the profile. It resolves
ownership from that stored session and never uses a claimed player reference as
the lookup key. If a claim is present it must match the session's player.
Unknown sessions, provider mismatches, player mismatches, and unsupported input
use stable reason codes and cannot change a profile.

The session expiry check occurs after the provider-scoped session row is locked.
If `expires_at <= received_at`, the session and current pending/manual-review
profile are expired through the central transition service and the callback is
durably acknowledged as `ignored_expired` with
`KYC_PROVIDER_EVENT_SESSION_EXPIRED`. The callback and worker therefore
serialize on the same row and cannot approve an elapsed session.

Provider timestamps may be at most `KYC_PROVIDER_MAX_FUTURE_SKEW_SECONDS`
(default 300 seconds) ahead of internal receipt time. A larger lead is stored as
a rejected event. Provider time remains available for bounded ordering, while
internal acceptance time is authoritative for `verified_at`, completion, and
verification TTL. Provider, receipt, and acceptance timestamps remain separate.

Accepted-event ordering is deterministic:

- the session must be the profile's current session;
- event time must be at or after session start and strictly later than the last
  accepted event;
- a terminal session cannot accept a later result;
- `pending` cannot regress manual review or a terminal state;
- the central transition table must permit the result.

Stale events remain stored as `ignored_stale`; ownership failures that have a
valid normalized identity remain stored as `rejected`. Invalid payloads without
the identifiers needed for safe persistence are represented by sanitized audit
records only. Raw payloads, webhook headers/signatures, identity documents, and
images are not retained. Provider adapters map raw metadata to a typed allowlist;
the fake adapter currently retains only a bounded reconciliation `source` value.

## Manual review

Entering `manual_review` atomically creates one active `kyc_manual_reviews`
record and an immutable `review_requested` action. `KycManualReviewService`
provides internal methods to open, assign, approve, reject, or resume a review.
Approval, rejection, and resumption call the central transition service and
complete the review in the same transaction.

Every action records review, player, and KYC profile IDs; previous and new KYC
status; canonical actor identity; reason codes; bounded internal notes; and UTC
creation time. The actions table rejects updates and deletes.

No admin HTTP endpoints are exposed in this phase because the active repository
does not yet have authenticated internal/admin identity middleware. Adding a
route that accepted a caller-supplied actor ID would weaken authorization. The
service requires a non-empty authenticated `ADMIN` actor context and is ready to
be connected when that middleware exists.

## Expiry and eligibility

`KycExpiryWorker` starts with the API process, polls once per minute, and runs
independent bounded batches of 100 sessions and 100 verified profiles. Repository scans use ordered `FOR UPDATE SKIP
LOCKED`, so repeated runs and multiple process instances are safe. A worker
never overlaps its own prior run. Pending/manual-review session expiry and
verified approval expiry both use the central transition mechanism.
The categories use separate transactions and failure reporting, so a session
backlog or category failure cannot prevent verified profiles from being attempted.

Request-time reads are also protected. `PostgresKycStatusReader`, KYC profile
reads, and new-session preparation synchronously transition an elapsed verified
profile to `expired` before returning or authorizing. Therefore an overdue
approval cannot grant deposit, withdrawal, or wagering permissions while the
worker is delayed.

Permissions are not a second mutable KYC projection. `eligibility-policy-v1`
derives and persists a fresh decision from the current profile on each check.
`GET /v1/me` therefore reflects approval, rejection, manual review, and expiry
without a separate permission update or outbox. Its six permissions share one
consistent snapshot and one database transaction.

## Migration and validation

```bash
npm run db:migrate
npm run typecheck
npm test
TEST_DATABASE_URL='<PostgreSQL URL ending in _test>' npm run test:integration:db
npm run build
```

`KYC_PROVIDER_MAX_FUTURE_SKEW_SECONDS` is the only new runtime setting. Worker
cadence and the two batch sizes remain fixed operational constants for this
focused phase. The populated upgrade test applies migrations 001–003, seeds
legacy KYC records, and then applies 004. Unknown legacy actor values are
preserved in metadata and normalized to non-privileged `SYSTEM`, never `ADMIN`.
Phase 3 already enforces `(provider, provider_event_id)` uniqueness, so duplicate
legacy provider-event identities cannot exist in a valid 003 database; migration
004 preserves that constraint and the upgrade test verifies duplicate rejection.
