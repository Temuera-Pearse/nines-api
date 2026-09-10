# nines-api

`nines-api` is the player-facing identity, KYC, and eligibility gateway for
Nines. Auth0 proves external human authentication, the player domain maps that
identity to a permanent internal UUID, the KYC domain owns verification state,
and the eligibility domain decides whether typed operations are allowed.

KYC status never grants financial authority. `nines-financial` remains
authoritative for money and `nines-back-end` remains authoritative for races.

## Checkpoint scope

This working tree is the Phase 1–4 checkpoint:

| Phase | Status | Scope |
|---|---|---|
| 1 | Complete | Auth0 human authentication, stable internal player identity, restricted-by-default provisioning, account-state history, audit, and PostgreSQL runtime foundation. |
| 2 | Complete | Versioned eligibility policy, player restrictions, persisted decisions, permission projection, and deny-by-default authorization inputs. |
| 3 | Complete | Provider-neutral KYC profiles, sessions, transitions, normalized provider events, idempotency, ordering, expiry logic, and eligibility integration. |
| 3.5 | Complete | Central lifecycle transitions, provider-event ownership/idempotency/ordering, auditable manual review, approval expiry worker, and request-time protection. |
| 4 | Complete | Provider-neutral external crypto funding intents, fake-provider sessions, authenticated callbacks, reconciliation, expiry, and durable confirmed-funding attestations. |

The hosted mock proves the integration boundary without pretending to perform
real identity verification. Phase 3.5 additionally hardens the complete KYC
lifecycle. See
[`docs/PHASE_3_5_KYC_LIFECYCLE_HARDENING.md`](docs/PHASE_3_5_KYC_LIFECYCLE_HARDENING.md)
for transition, event, review, expiry, and concurrency rules.
See [`docs/PHASE_4_CRYPTO_FUNDING.md`](docs/PHASE_4_CRYPTO_FUNDING.md) for the
crypto lifecycle, provider contract, exact-amount, callback, reconciliation,
and outbox rules.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for completed scope and deferred work.

## Phase 3 and 3.5 architecture

```text
Auth0 human token
  -> internal player UUID
  -> provider-neutral KYC profile and session
  -> verified and normalized provider event
  -> internal KYC transition
  -> eligibility-policy-v1 reads stored KYC status
  -> persisted allow/deny decision
```

Provider events update KYC state only. They never set permissions. Eligibility
continues to combine KYC with account status and active restrictions.

The Phase 3.5 provider is deterministic and local:

> The fake provider verifies no real identity.

It performs no network calls and is not a production-ready identity-verification
system.

## Configuration

Runtime prerequisites are Node.js 20 or newer and PostgreSQL.

Create an ignored local `.env.local` using the variable contract below. Never
commit environment files or real connection credentials.

| Variable | Required | Description |
|---|---:|---|
| `NODE_ENV` | No | `development`, `test`, or `production`; default `development`. |
| `PORT` | No | HTTP port; default `3002`. |
| `AUTH0_ISSUER` | Yes | Auth0 issuer URL. HTTPS is mandatory in production. |
| `AUTH0_AUDIENCE` | Yes | Expected Auth0 API audience. |
| `DATABASE_URL` | Yes outside unit tests | PostgreSQL connection URL. |
| `CORS_ORIGIN` | No | Comma-separated exact HTTP origins. |
| `KYC_PROVIDER` | No | Phase 3 supports only `fake`. |
| `KYC_SESSION_TTL_MINUTES` | No | Positive session lifetime; default `60`. |
| `KYC_VERIFICATION_TTL_DAYS` | No | Positive verified-profile lifetime; default `365`. |
| `KYC_PROVIDER_MAX_FUTURE_SKEW_SECONDS` | No | Maximum accepted provider event clock lead; default `300`. |
| `ENABLE_FAKE_KYC_TEST_ROUTES` | No | Enables the hosted mock page and outcome endpoint in development/test. Default `false`; production rejects `true`. |
| `PUBLIC_API_BASE_URL` | Hosted mock flow | Public API origin used to build mock provider URLs; defaults to `http://localhost:<PORT>` outside production. |
| `CRYPTO_FUNDING_ENABLED` | No | Defaults to `false`; requires an explicitly configured supported provider. |
| `CRYPTO_PROVIDER` | When funding enabled | Phase 4 supports only `fake`, and rejects enabled fake funding in production. |
| `CRYPTO_SUPPORTED_ASSETS` | No | Comma-separated `ASSET:DECIMALS` values; default `USDC:6`. |
| `CRYPTO_FUNDING_MIN_AMOUNT` | No | Positive exact decimal string; default `1`. |
| `CRYPTO_FUNDING_MAX_AMOUNT` | No | Positive exact decimal string; default `100000`. |
| `CRYPTO_FUNDING_INTENT_TTL_MINUTES` | No | Positive internal intent lifetime; default `60`. |
| `CRYPTO_PROVIDER_MAX_FUTURE_SKEW_SECONDS` | No | Maximum accepted provider timestamp lead; default `300`. |
| `CRYPTO_FAKE_WEBHOOK_SECRET` | Fake funding | At least 16 characters; development/test only. |
| `TEST_DATABASE_URL` | Integration tests | Dedicated PostgreSQL database ending in `_test`. |

Unsupported providers, invalid TTLs, fake production route configuration,
invalid Auth0 configuration, and invalid database configuration fail startup.
There are no real-provider secrets in the Phase 3.5 checkpoint.

## Database

Migrations are applied in order:

1. `001_phase_1_player_identity.sql`
2. `002_phase_2_eligibility.sql`
3. `003_phase_3_kyc.sql`
4. `004_phase_3_5_kyc_lifecycle_hardening.sql`
5. `005_phase_4_crypto_funding.sql`

Phase 3 adds:

- `player_kyc_profiles`: one authoritative profile per player, optimistic
  version, current session, verification and expiry timestamps.
- `kyc_verification_sessions`: internal UUID, provider-scoped reference,
  attempt number, safe verification URL, idempotency key, and lifecycle dates.
- `kyc_provider_events`: normalized event identity, deterministic SHA-256 hash,
  processing outcome, sanitized metadata, and correlation data.
- `kyc_status_transitions`: immutable profile-state history.
- `kyc_manual_reviews` and `kyc_manual_review_actions`: controlled review state
  and immutable review-action history.

Database enforcement includes:

- unique player profile;
- unique `(provider, provider_session_reference)`;
- unique `(player_id, idempotency_key)`;
- a partial unique index allowing one effective
  `creating|pending|manual_review` session per player;
- typed status and timestamp constraints;
- append-only KYC transition triggers;
- immutable provider-event identity fields and no event deletion;
- indexes by player, session, correlation, event reference, expiry, and time.
- a deferred guard requiring every committed profile status change to have a
  matching transition for the new profile version.

No documents, photographs, biometrics, raw provider payloads, raw headers,
access tokens, or full identity details are stored.

Phase 4 adds funding intents and provider sessions, normalized callback events,
append-only funding transitions, explicit reconciliation records, and an
immutable confirmed-funding attestation outbox. The physical legacy table remains
named `financial_funding_instructions`. Critical idempotency keys are unique
in PostgreSQL, and a deferred trigger requires every status change to have a
matching transition record.

## Crypto funding API

Authenticated players use `POST /v1/crypto/funding-intents` with an
`Idempotency-Key`, then owner-scoped `GET /v1/crypto/funding-intents` and
`GET /v1/crypto/funding-intents/:id`. Creation reuses the existing `deposit`
eligibility decision. The internal intent UUID is the external provider's
mandatory idempotency key.

Authenticated provider events enter at
`POST /internal/provider-events/crypto/:provider`. The fake provider separates
`detected`, `confirming`, and `confirmed`; only final confirmation atomically
creates one durable confirmed-funding attestation. Mismatched or late external value
is reconciled rather than credited. No player balance or ledger is implemented
here. See the Phase 4 document for the full contract.

```bash
npm run db:migrate
```

## KYC state model

Profile statuses are:

- `not_started`: no attempt has begun.
- `pending`: a provider session awaits a result.
- `verified`: the current requirement was successfully completed.
- `failed`: the latest completed attempt failed.
- `manual_review`: the current attempt requires human review.
- `expired`: the session or prior verification is no longer current.

Allowed transitions are:

```text
not_started -> pending
pending -> verified | failed | manual_review | expired
manual_review -> verified | failed | pending | expired
verified -> expired | manual_review
failed -> pending
expired -> pending
```

No-op and unsupported transitions return `KYC_INVALID_STATE_TRANSITION`. In particular,
`verified -> pending`, `verified -> failed`, `failed -> verified`, and
`expired -> verified` are invalid without the correct new-session progression.
A failed or expired player may start a new attempt and transition back to
`pending`.

Session-only states `creating` and `creation_failed` model the provider call
boundary. They do not enter the player-facing profile vocabulary.

## Starting a verification session

`StartKycVerificationService` follows this sequence:

1. load the player and evaluate `start_kyc`;
2. transactionally create/read the profile, lock it, reuse an active or
   idempotent session, or create a `creating` intent;
3. commit the intent;
4. call `KycProvider.createVerificationSession` with no open transaction, using
   the immutable internal session UUID as the mandatory provider idempotency key;
5. transactionally activate the intent and move the profile to `pending`;
6. append transition and audit records.

Concurrent requests converge on one effective session. When hosted mock routes
are enabled, the fake provider uses the validated `PUBLIC_API_BASE_URL` and
internal session UUID to produce a deterministic hosted verification URL.
Repeated `Idempotency-Key` values resolve to the same stored attempt. Every real
adapter must map the supplied internal-session idempotency key to its provider's
idempotency facility. A provider failure marks the intent `creation_failed`,
keeps the profile unchanged, and deterministically replays the safe
`503 KYC_SESSION_CREATION_FAILED` response for that client key. A new attempt
requires a new client `Idempotency-Key`.

An already verified, unexpired profile returns `KYC_ALREADY_VERIFIED`. Closed
accounts are denied by `eligibility-policy-v1`.

## Provider events and ordering

`ProcessKycProviderEventService`:

1. verifies and normalizes through the configured `KycProvider`;
2. hashes a canonical representation of the controlled event input;
3. inserts `(provider, provider_event_id)` idempotently and rejects identity
   reuse with different content;
4. locks the provider-scoped session and current profile;
5. rejects excessive provider clock skew and, while holding the session lock,
   expires sessions whose expiry is at or before the internal receipt time;
6. applies ownership, ordering, and transition rules;
7. atomically updates the session/profile, transition, event outcome, and audit
   records.

Only normalized status, operational references, separate provider/receipt/
acceptance times, event hash, and explicitly allowlisted adapter metadata are
persisted. The current fake adapter allows only `source`; unknown and sensitive
metadata fields are discarded. Raw provider requests are not retained.

Ordering rules are:

- only the profile’s current internal session may update it;
- events before session start are stale;
- event time must be strictly later than the session’s last accepted event;
- a late `pending` event cannot replace `manual_review` or a terminal result;
- terminal sessions reject later results;
- an older attempt cannot overwrite a newer attempt;
- the first valid terminal result serialized under the session row lock wins;
- duplicates return the existing event identity and do not reapply state.
- provider time may lead internal receipt time by at most the configured skew;
- receipt/acceptance time, never provider time, starts verification validity.

Stale and unknown-session events remain recorded as `ignored_stale` or
`rejected`. A claimed player must match the owner resolved from the stored
session. Duplicate delivery emits an `ignored_duplicate` audit event without
rewriting the original processed record.

## Manual review

Entering `manual_review` creates one active review and an immutable requested
action. Internal application methods support open, assignment, approval,
rejection, and resumption; decisions pass through the central transition
service. Admin HTTP routes remain intentionally absent until the repository has
authenticated internal/admin identity middleware.

## Phase 3.5 development end-to-end flow

Phase 3.5 contains the following working flow:

1. `nines-front-end` signs the player in with Auth0 and obtains a human API
   access token.
2. The frontend loads `GET /v1/me` and `GET /v1/me/kyc`.
3. `POST /v1/me/kyc/sessions` verifies the Auth0 token, resolves the internal
   player, authorizes `start_kyc`, and creates or reuses a provider-neutral
   session.
4. The fake provider returns a hosted development URL compatible with the
   frontend popup lifecycle.
5. Pass or Fail on the hosted page becomes a normalized fake-provider event.
6. `ProcessKycProviderEventService` applies the same idempotency, ordering, row
   locking, transition, audit, and eligibility rules intended for a real
   provider.
7. The popup sends a narrow completion/cancellation message; the frontend
   validates it and refreshes both player and KYC state. No Auth0 token is
   passed to the popup.

What remains mocked:

- provider session creation and provider session references;
- identity document, biometric, liveness, and sanctions checks;
- provider-hosted UI beyond the local Pass/Fail/Cancel simulation;
- webhook signature verification and production provider credentials;
- provider-driven manual-review operations;
- production callback delivery, retry, and outage handling.

### Hosted mock provider

With `NODE_ENV=development`, `ENABLE_FAKE_KYC_TEST_ROUTES=true`, and
`PUBLIC_API_BASE_URL=http://localhost:3002`, a created fake session points to:

```text
GET /dev/kyc/mock/:sessionId
```

The standalone HTML page simulates an external hosted provider and offers Pass,
Fail, and Cancel. Pass or Fail submits:

```text
POST /dev/kyc/mock/:sessionId/outcome
{"outcome":"pass"|"fail"}
```

The route validates that the UUID belongs to the current, unexpired, pending
fake-provider session. It builds a deterministic fake-provider event and calls
`ProcessKycProviderEventService`; it does not update profile or session tables
directly. Duplicate outcomes are idempotent, and the existing row locks, event
ordering, stale-session checks, transition validation, append-only history,
audit records, and eligibility reads remain authoritative.

The page carries no Auth0 token and the outcome endpoint requires no browser
credential in its URL. These routes are registered only in development/test.
Production configuration rejects the enable flag, and the paths return the
normal 404 when disabled.

## Expiry

`KycExpiryWorker` starts with the API and invokes `ExpireKycSessionsService`
once per minute with independent bounded batches of 100 sessions and 100
verified profiles.

- Pending/manual-review sessions past expiry become `expired`.
- A profile changes only when the expired session is still current.
- Verified profiles with elapsed `expires_at` become `expired`.
- Obsolete sessions cannot expire a newer profile.
- Repeated expiry runs are idempotent.
- Ordered `FOR UPDATE SKIP LOCKED` claims make concurrent workers safe.
- Session backlog cannot consume verified-profile expiry capacity.
- Category failures are reported independently and do not prevent the other
  category from being attempted.
- Request-time status/profile reads expire overdue approvals synchronously.

All times are PostgreSQL `TIMESTAMPTZ`/UTC instants.

## Eligibility integration

The Phase 2 placeholder is removed. `PostgresKycStatusReader` reads
`player_kyc_profiles`; an absent profile safely resolves to `not_started`, and
the first normal eligibility read lazily creates and audits that profile. An
invalid stored value produces a deny-by-default policy input.

`EvaluateEligibilityService` reads KYC itself inside each persisted evaluation.
Callers cannot supply an arbitrary KYC status. `/v1/me` loads one consistent
restriction/KYC snapshot in one transaction, evaluates all six permissions in
memory, and persists the six decisions without six simultaneous connections.

Policy v1 remains:

| Operation | Rule |
|---|---|
| `view_races` | Allowed unless account is closed. |
| `deposit` | Active account, verified KYC, no deposit, jurisdiction, or KYC-required block. |
| `withdraw` | Active account, verified KYC, no withdrawal/KYC-required block. |
| `place_wager` | Active account, verified KYC, no wagering, self-exclusion, jurisdiction, security-review, or KYC-required block. |
| `start_kyc` | Allowed unless account is closed. |
| `manage_profile` | Allowed for an authenticated player. |

Verified KYC does not bypass restricted, suspended, or closed accounts and does
not bypass any active restriction.

## Player API

All routes require a valid human Auth0 access token.

### `GET /v1/me/kyc`

Lazily creates and returns a safe profile:

```json
{
  "status": "not_started",
  "verifiedAt": null,
  "expiresAt": null,
  "currentSession": null
}
```

While pending, `currentSession` contains only the internal session UUID,
provider name, expiry, safe verification URL, and status. Provider event IDs,
provider session references, hashes, metadata, failure internals, and transition
history are not returned.

### `POST /v1/me/kyc/sessions`

Starts or resumes KYC. It supports an optional safe `Idempotency-Key`, evaluates
`start_kyc`, and delegates all state changes to the application service.

```json
{
  "sessionId": "00000000-0000-0000-0000-000000000000",
  "status": "pending",
  "provider": "fake",
  "verificationUrl": "http://localhost:3002/dev/kyc/mock/...",
  "expiresAt": "2026-07-24T10:00:00.000Z"
}
```

The hosted outcome route described above exists only when explicitly enabled
outside production. It is not a production player API and cannot bypass the
provider-event processor.

### `GET /v1/me`

The existing response now reports stored `kycStatus`. Permissions remain
persisted eligibility decisions and update after normalized KYC events.

`GET /auth/me` remains deprecated compatibility behavior and must not be used
for server-side authorization.

## Audit and errors

KYC emits:

- `kyc.profile_created`
- `kyc.session_requested`, `kyc.session_created`, `kyc.session_reused`,
  `kyc.session_failed`
- `kyc.event_received`, `kyc.event_processed`,
  `kyc.event_ignored_duplicate`, `kyc.event_ignored_stale`,
  `kyc.event_ignored_expired_session`, `kyc.event_identity_conflict`,
  `kyc.event_rejected`
- `kyc.status_changed`
- `kyc.manual_review_opened`, `kyc.manual_review_assigned`
- `kyc.session_expired`, `kyc.verification_expired`

General audit metadata is recursively sanitized; provider-event metadata uses
an adapter-specific allowlist. Public errors use
stable codes such as `KYC_ALREADY_VERIFIED`, `KYC_SESSION_CREATION_FAILED`,
`KYC_EVENT_INVALID`, `KYC_INVALID_STATE_TRANSITION`,
`KYC_PROVIDER_SESSION_NOT_FOUND`, `KYC_PROVIDER_MISMATCH`,
`KYC_PLAYER_MISMATCH`, `KYC_REVIEW_NOT_FOUND`, `KYC_OPERATION_NOT_ALLOWED`, and
`KYC_STATE_CONFLICT`. Provider and PostgreSQL details remain internal.

## Local workflow

```bash
npm install
# Create an ignored .env.local using the configuration table above.
# For the local hosted mock flow:
# ENABLE_FAKE_KYC_TEST_ROUTES=true
# PUBLIC_API_BASE_URL=http://localhost:3002
npm run db:migrate
npm run typecheck
npm test
TEST_DATABASE_URL='<dedicated PostgreSQL URL ending in _test>' npm run db:migrate:test
TEST_DATABASE_URL='<dedicated PostgreSQL URL ending in _test>' npm run test:integration:db
npm run build
npm audit --omit=dev
npm run dev
```

The integration reset refuses any database whose name does not end in `_test`.

## Inactive historical material

Historical material is retained for reference only:

- `src/migrated-from-backend` is excluded from TypeScript compilation and the
  active Vitest suite, and no active application module imports it.
- `db/migrations/migrated-from-backend` is not traversed by the migration
  runner, which reads only direct `.sql` files in `db/migrations`.
- `docs/migrated-from-backend` describes superseded backend work and is not the
  active roadmap.

None of these directories are part of the production build or migration plan.

## Deferred work

Phases 3 through 4 deliberately defer:

- a real KYC provider and production webhook authentication;
- provider-managed document and biometric handling;
- identity-document upload or storage;
- authenticated operator HTTP routes for the implemented manual-review service;
- notification, email, and SMS integrations;
- jurisdiction and geolocation providers;
- responsible-gambling integrations;
- real crypto providers, custody, wallets, keys, withdrawals, betting, and race integration.

## Confirmed funding attestations

Provider-confirmed USDC funding creates an immutable
`external_funding_confirmed` v1 attestation and a Security evidence outbox row
in the same transaction. A leased retry worker sends the attestation to
`nines-financial`; API does not calculate NINES, create financial accounts, or
write a ledger. Financial and Security delivery are separately configurable.
Pre-attestation Phase 4 rows are retained as
`legacy_reconciliation_required`; they are never fabricated into v1 evidence or
sent through the v1 delivery worker.
HMAC service authentication is development/test-only and production startup
fails closed until a production authenticator is configured.
