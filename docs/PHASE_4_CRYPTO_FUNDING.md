# Phase 4 — provider-neutral crypto funding

Phase 4 owns the lifecycle at the boundary between an authenticated player, an
external crypto funding provider, and a future financial service. It does not
own balances, a ledger, conversion, custody, wallets, keys, withdrawals,
wagering, or settlement.

```text
authenticated player
  -> deposit eligibility
  -> CryptoFundingIntent
  -> CryptoFundingProvider session
  -> authenticated normalized provider events
  -> confirmed external funding
  -> FinancialFundingInstruction outbox row
  -> future nines-financial consumer
```

The only implemented provider is deterministic `fake`, and configuration
rejects enabling it in production. No real external crypto transfer occurs.

## Lifecycle and central transition rule

All status changes pass through `TransitionCryptoFundingService`, which locks
the intent, validates the transition, applies an optimistic version update,
and writes immutable transition and audit records in the caller's transaction.
A deferred database trigger rejects any committed status update without the
matching transition row and version.

| From | Allowed destinations |
|---|---|
| `provider_pending` | `awaiting_payment`, `creation_failed`, `failed`, `expired` |
| `awaiting_payment` | `detected`, `confirming`, `confirmed`, `failed`, `expired`, `reconciliation_required` |
| `detected` | `confirming`, `confirmed`, `failed`, `expired`, `reconciliation_required` |
| `confirming` | `confirmed`, `failed`, `expired`, `reconciliation_required` |
| `confirmed` | none |
| `failed` | none |
| `expired` | none |
| `reconciliation_required` | none |
| `creation_failed` | none |

`detected` and `confirming` are deliberately not equivalent to `confirmed`.
Only `confirmed` creates a financial instruction. Terminal states cannot be
revived by ordinary provider events.

## Creating a funding intent

`POST /v1/crypto/funding-intents` requires a human access token and a bounded
`Idempotency-Key`. Its body is `{ "asset": "USDC", "amount": "100.00" }`.
The service asks the existing eligibility policy about `deposit`; it does not
repeat account, KYC, restriction, or jurisdiction rules.
The authoritative deposit policy denies active `jurisdiction_blocked`
restrictions as well as account, KYC, and deposit-specific restrictions.

The flow has two short transactions around the provider call:

1. Resolve eligibility and transactionally create or find one intent and one
   `creating` provider-session row.
2. Commit, then call `CryptoFundingProvider.createFundingSession` without a
   database transaction.
3. Transactionally lock the intent, persist the provider reference, transition
   to `awaiting_payment`, and audit the outcome.

The database unique key `(player_id, idempotency_key)` collapses concurrent
HTTP requests. A SHA-256 hash over canonical asset and amount distinguishes an
equivalent replay from reuse with different parameters. The immutable internal
intent UUID is always the provider idempotency key. Every adapter must map that
key to the provider's native idempotency mechanism. This makes a crash after a
successful provider call recoverable by replaying the same provider operation.
The fake adapter actively enforces and concurrently tests the rule.

A definite provider rejection moves the intent/session to `creation_failed`
and replays the same safe `CRYPTO_FUNDING_CREATION_FAILED` result for that
client key. An ambiguous outage or timeout leaves `provider_pending`, returns
`CRYPTO_PROVIDER_UNAVAILABLE`, and safely retries with the same internal
provider idempotency key. A new attempt after a definite failure requires a new
HTTP idempotency key.

Public reads are owner-scoped:

```text
GET /v1/crypto/funding-intents
GET /v1/crypto/funding-intents/:id
```

They expose only lifecycle fields and the safe provider session reference/URL.
They never expose client idempotency keys, hashes, raw events, credentials,
audit metadata, or webhook secrets.

## Provider interface and callbacks

`CryptoFundingProvider` has two required operations:

- `createFundingSession(input)`, including the intent UUID as the mandatory
  provider idempotency key;
- `parseAndVerifyEvent(raw)`, which authenticates and returns the common,
  normalized provider event.

`POST /internal/provider-events/crypto/:provider` sends callbacks through that
adapter. The fake adapter uses a configured shared secret solely for local and
test use. A real adapter must authenticate before normalization, verify the
configured provider identity, implement provider idempotency, and return only
the normalized fields. Exact request bytes and ephemeral headers are available
to adapters for provider-specific signature schemes, but are never persisted.
Provider-specific routing/authentication can be added inside the adapter and
ingress composition without changing the funding domain.

Only these optional metadata fields survive normalization:
`providerTransactionId`, `confirmationStage`, and non-negative integer
`sequence`. Raw payloads, headers, wallet data, arbitrary metadata, and secrets
are neither persisted nor logged. The stored SHA-256 payload hash supports
identity-collision detection without retaining the payload.

Event processing uses one database transaction for event insertion,
provider-scoped intent locking, ownership checks, expiry checks, stale/order
checks, transition and audit writes, reconciliation, processing outcome, and
financial instruction creation. `(provider, provider_event_id)` is unique.
Repeated identical delivery is acknowledged as `ignored_duplicate`; reuse of
an identity with different content is durably audited before the HTTP conflict
is returned.

`provider_occurred_at`, internal `received_at`, and `accepted_at` are stored
separately. Provider time participates only in ordering after the configured
future-skew guard. Internal receipt time controls expiry and confirmation time.
A newer lifecycle state cannot regress, equal/older timestamps are stale, and
confirmed intents never move backwards.
An event claiming to have occurred before its intent existed is stale.

If financial-instruction persistence fails, the transaction rolls back the
confirmation, transition, event insert, and audit together. A replay can retry
the whole operation. Two instances serialize on the intent row; duplicate
event and instruction uniqueness provide additional protection.

If an authenticated callback arrives after provider creation but before its
response is stored, the signed internal intent claim may recover only that
provider's still-`provider_pending` intent under lock. The callback attaches the
provider reference, activates the session, and then follows the normal event
pipeline. A claimed player ID is never used to resolve ownership.

## Exact amounts, assets, expiry, and reconciliation

Assets and decimal precision come from `CRYPTO_SUPPORTED_ASSETS` entries such
as `USDC:6`. Amounts are bounded, positive decimal strings, canonicalized, and
compared with `BigInt` smallest units. JavaScript `number` is never used for an
authoritative amount. Global configured minimum and maximum values apply to
each configured asset; production asset economics remain deliberately
undecided.

Provider-reported external value must exactly match the expected asset and
amount. `UNDERPAID`, `OVERPAID`, `ASSET_MISMATCH`, and
`AMOUNT_UNDETERMINED` create explicit open reconciliation records and never an
instruction. Unknown provider references are also retained as reconciliation
records. Evidence of external value against an already failed creation/funding
intent is retained as `PAYMENT_ON_TERMINAL_INTENT`.

The independent worker claims bounded, ordered batches with
`FOR UPDATE SKIP LOCKED`. It is repeatable and safe across concurrent
instances. Expiry after `detected` or `confirming` also creates an operational
reconciliation record. A callback at or after internal expiry cannot revive an
intent; evidence that value moved becomes `PAYMENT_AFTER_EXPIRY`.

## Financial handoff

`financial_funding_instructions` is a transactional outbox for a future
`nines-financial` consumer. A row contains the funding intent/player, external
asset and amount, provider/reference, confirmation time, and delivery status.
The unique `funding_intent_id` enforces exactly one logical instruction per
confirmed intent. A deferred database guard also prevents a confirmed intent
from committing unless its matching instruction exists; instruction financial
fields are immutable while delivery status remains updateable. Phase 4 does
not deliver it, convert it, create a ledger entry, or mutate a player balance.

Open discrepancies live in `crypto_funding_reconciliations`; there is no
automatic financial repair or operator UI. `FINANCIAL_INSTRUCTION_MISSING` is
reserved in the persisted discrepancy vocabulary for a future reconciliation
scanner.

## Configuration

Funding is disabled by default. Development/test setup requires:

```text
CRYPTO_FUNDING_ENABLED=true
CRYPTO_PROVIDER=fake
CRYPTO_FAKE_WEBHOOK_SECRET=<at least 16 characters>
CRYPTO_SUPPORTED_ASSETS=USDC:6
CRYPTO_FUNDING_MIN_AMOUNT=1
CRYPTO_FUNDING_MAX_AMOUNT=100000
CRYPTO_FUNDING_INTENT_TTL_MINUTES=60
CRYPTO_PROVIDER_MAX_FUTURE_SKEW_SECONDS=300
```

Missing providers/secrets, invalid assets or ranges, and enabling fake funding
in production fail closed. A future real provider requires extending the
validated provider configuration, implementing `CryptoFundingProvider`,
wiring that adapter in `createApp`, and documenting its authentication,
idempotency, timeout, retry, and finality guarantees.

## Security and deferred work

Audit events provide stable hooks for funding requested, session created,
payment detected/progressed/confirmed, discrepancies, expiry, and the outbox
write. This keeps future security and auditing consumers observational and
avoids making them sources of truth.

Explicitly deferred: a real provider, blockchain access, custody, keys and seed
phrases, wallets, conversion/rates, internal balances and ledger, outbox
delivery, withdrawals, fiat, AML/fraud case management, admin UI, wagering,
payouts, settlement, `nines-security`, and `nines-auditing`.
