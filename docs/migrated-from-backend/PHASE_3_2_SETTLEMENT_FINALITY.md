# Phase 3.2 Settlement Finality

Date: 2026-04-29

## Authority Boundary

- `nines-back-end` remains authoritative for race timing and persisted race
  results.
- `nines-financial` remains authoritative for accepted financial bets, pool
  state, settlement calculation, ledger postings, and settlement finality.
- Backend-local `bets` rows are non-authoritative read models for UI,
  performance, and legacy compatibility.

## Backend Settlement Contract

The backend settlement flow now submits only official race result inputs to
`nines-financial`:

- `raceId`
- `winningSelectionId`
- `houseTakeBps`
- `idempotencyKey`
- `correlationId`
- `causationId`
- `currency = "USDC"`

The backend no longer submits `acceptedBets`, `totalPoolMinor`, or payout
truth. `nines-financial` reads canonical `financial_bets`, calculates payouts,
posts ledger effects, terminalizes financial bets, and settles the pool.

## Local Bet Read Model

After `nines-financial` returns a completed settlement, backend-local unsettled
bet rows are updated from the financial settlement response where matching
local rows exist. Missing or extra local rows are drift in the read model, not
financial truth. The existing reconciliation endpoint remains detection-only:

```http
GET /settlements/reconciliation/races/:raceId
```

## Terminal Responses

The backend expects a terminal settlement response containing:

- `settlementRunId`
- `status`
- `reasonCode`
- pool totals and house take
- `carryoverMinor`
- terminal settled bet results
- `settledAt`

`status = completed` is the normal path. `manual_review` is treated as a clear
conflict for backend callers and should be handled by operational recovery.

## Remaining Limitations

- Backend reconciliation detects local/financial drift but does not repair it.
- Pending carryovers are persisted in `nines-financial` and applied to future
  eligible pools by backend lifecycle orchestration.
- Backend local bet rows still retain legacy wallet references for compatibility
  and should not be used as financial authority.
