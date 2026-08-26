# nines-api roadmap

This roadmap records the boundary of the Phase 1–4 checkpoint.

## Phase 1 — player identity and API foundation

Status: complete.

- Validate human Auth0 access tokens using issuer, audience, RS256, expiry, and
  JWKS.
- Reject machine-to-machine tokens on player routes.
- Map external Auth0 identity to a stable internal player UUID.
- Provision new players as restricted and record immutable identity links.
- Persist audit events and account-status transition history.
- Provide correlation IDs, structured errors, health checks, migrations,
  PostgreSQL transactions, and graceful shutdown.

## Phase 2 — eligibility and restrictions

Status: complete.

- Define typed player operations and `eligibility-policy-v1`.
- Evaluate account status, authoritative KYC status, and active restrictions.
- Persist eligibility decisions, input snapshots, reason codes, and audit
  events.
- Project safe player permissions through `GET /v1/me`.
- Implement restriction and account-status application services.

Operator routes and scheduled restriction expiry remain deferred.

## Phase 3 — provider-neutral KYC core

Status: complete.

- Persist one authoritative KYC profile per player.
- Model verification-session intent, activation, failure, attempts, and
  idempotency.
- Normalize provider events behind the `KycProvider` interface.
- Enforce event identity, ordering, stale-session protection, row locking,
  optimistic profile versioning, allowed transitions, and append-only history.
- Feed stored KYC status into eligibility evaluations.
- Implement idempotent session and verification expiry logic.

A scheduler and real provider are not part of Phase 3.

## Phase 3.5 — end-to-end integration and lifecycle hardening

Status: complete.

- Return a hosted mock verification URL from fake-provider sessions.
- Serve a standalone Pass/Fail/Cancel page only when explicitly enabled
  outside production.
- Submit Pass and Fail through `FakeKycProvider` and the normal
  `ProcessKycProviderEventService` path.
- Preserve duplicate, stale-event, superseded-session, transaction, transition,
  audit, and eligibility behavior.
- Support the `nines-front-end` Auth0 sign-in, protected player/KYC reads,
  popup lifecycle, narrow completion message, and authoritative refresh flow.
- Keep access tokens out of the popup and prevent the mock routes from being
  enabled in production.
- Enforce every status change through one transition service and a deferred
  database transition guard.
- Protect provider callbacks with database idempotency, ordering, ownership,
  durable identity-collision audits, locked expiry enforcement, bounded clock
  skew, and row locking.
- Require the internal session UUID as the provider creation idempotency key and
  replay failed client keys with a stable safe response.
- Persist controlled manual reviews and immutable review actions; expose only
  authenticated internal service methods until admin middleware exists.
- Run independent bounded concurrent-safe session/profile expiry batches and
  expire overdue approvals at request time before eligibility projection.
- Project `/v1/me` permissions from one consistent eligibility snapshot and one
  database transaction.

The fake provider performs no real document, biometric, liveness, sanctions,
identity, or manual-review work. It has no production webhook authentication,
provider credentials, callback retries, or outage behavior.

## Historical material

The following paths are inactive reference material:

- `src/migrated-from-backend`
- `db/migrations/migrated-from-backend`
- `docs/migrated-from-backend`

The source directory is excluded from compilation and unit tests. The migration
runner reads only direct SQL files from `db/migrations` and does not recurse
into the historical directory. Active runtime code imports neither source nor
historical documentation.

## Phase 4 — provider-neutral crypto funding

Status: complete.

- Create owner-scoped external funding intents after existing deposit
  eligibility succeeds.
- Enforce HTTP idempotency in PostgreSQL and use the immutable internal intent
  UUID for mandatory provider-side idempotency.
- Separate provider calls from short intent preparation/activation
  transactions.
- Normalize and authenticate callbacks behind `CryptoFundingProvider` with
  event identity, ordering, clock-skew, ownership, expiry, and row-lock rules.
- Distinguish payment detection and confirmation from final confirmation.
- Persist immutable lifecycle transitions, audits, processing outcomes, and
  discrepancy/reconciliation records.
- Produce exactly one durable `FinancialFundingInstruction` outbox row on
  confirmation without changing an internal balance.
- Run a bounded concurrent-safe funding-intent expiry worker.
- Supply a deterministic development/test fake provider. No real crypto or
  custody operation is performed.

See `docs/PHASE_4_CRYPTO_FUNDING.md` for the complete boundary and adapter
contract.

Production KYC/crypto providers, operator APIs, restriction scheduling,
financial outbox delivery, balances, ledger, conversion, custody, withdrawals,
rate limiting, fraud/AML systems, wagering, settlement, and race authority
remain deferred. Phase 5 has not begun.
