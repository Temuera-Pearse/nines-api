# Phase 3.1 Race Lifecycle / Financial Pool Orchestration

Date: 2026-04-29

## Authority Boundary

- `nines-back-end` remains authoritative for race timing, lifecycle, and
  persisted race results.
- `nines-financial` remains authoritative for financial pool state, accepted
  bets, reservations, ledger postings, and settlement calculation.
- Backend-local `bets` rows are non-authoritative read models for UI,
  performance, and legacy compatibility. Canonical accepted financial bets live
  in `nines-financial.financial_bets`.

## Lifecycle Wiring

Normal race flow now drives financial pool setup automatically:

- seeded/open betting race -> `CreateRacePool`
- valid horses/selections -> `RegisterPoolSelection`
- pool opened with selections -> `ApplyCarryoversToRace`
- backend betting close/race start -> `FreezePool`

`src/services/raceFinancialLifecycleService.ts` owns the backend orchestration
and uses deterministic idempotency keys per race/selection/freeze event.
Duplicate lifecycle events in one backend process are coalesced, and duplicate
commands sent to `nines-financial` are safe.

## Settlement Guardrails

The backend settlement path now:

- reads the financial race pool and requires `status = frozen`
- sends `SettleBet` with race result inputs only
- does not submit accepted bet lists, pool totals, or payout truth
- updates backend-local read models from the terminal financial settlement
  response where matching rows exist

Settlement will not proceed when the financial pool is missing or still open.

## Reconciliation Scaffolding

Manual/admin drift detection is available at:

```http
GET /settlements/reconciliation/races/:raceId
```

Detected cases:

- backend race exists but financial pool is missing
- backend closed/finished race has an open financial pool
- financial accepted bet is missing a backend read-model row
- backend pending local bet is missing a financial accepted bet

This is detection only. Automatic repair/replay is intentionally left out of
Phase 3.1.

## Remaining Limitations

- Backend local bet rows still carry a wallet foreign key for legacy
  compatibility.
- Recovery helpers report drift but do not repair read models or replay failed
  lifecycle commands automatically.
- Pending financial carryovers are applied during normal pool opening by the
  Phase 3.4 lifecycle orchestration call.
