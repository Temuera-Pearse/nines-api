# nines-api roadmap

This roadmap records the boundary of the Phase 1–3.5 checkpoint. It is not an
authorization to begin Phase 4 work as part of the checkpoint commit.

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

## Phase 3.5 — mock end-to-end KYC integration

Status: complete for local development and automated integration testing.

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

## Phase 4 — deferred

Status: not started.

Candidate work, subject to a separate design and authorization:

1. Production KYC provider adapter and authenticated webhook ingress.
2. Operator authentication, account-state and restriction APIs, and
   manual-review workflow.
3. Scheduled KYC and restriction expiry workers.
4. Downstream eligibility enforcement contracts.
5. Rate limiting, security headers, metrics, tracing, alerting, and audit
   retention.
6. Jurisdiction, responsible-gambling, notification, and security providers.

Payments, wallets, ledgers, wagering, settlement, and race authority remain in
their respective services and are not part of this roadmap checkpoint.
