import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { getSettlementService } from '../services/settlementService.js'
import { getFinancialReconciliationService } from '../services/financialReconciliationService.js'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../user/errors.js'

function readToken(req: Request): string | null {
  const headerToken = req.headers['x-api-token']
  if (typeof headerToken === 'string') return headerToken
  const queryToken = req.query['token']
  return typeof queryToken === 'string' ? queryToken : null
}

function requireAdminApiToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_API_TOKEN || process.env.API_TOKEN || ''
  if (!expected && process.env.REQUIRE_API_TOKEN !== '1') return next()
  const token = readToken(req)
  if (token && token === expected) return next()
  return res.status(401).json({ error: 'unauthorized' })
}

function handleRouteError(error: unknown, res: Response): void {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message })
    return
  }
  if (error instanceof ConflictError) {
    res.status(409).json({ error: error.message })
    return
  }
  if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message })
    return
  }
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message })
    return
  }
  res
    .status(500)
    .json({ error: error instanceof Error ? error.message : String(error) })
}

const router = Router()
const settlementService = getSettlementService()
const financialReconciliationService = getFinancialReconciliationService()

router.get(
  '/reconciliation/races/:raceId',
  requireAdminApiToken,
  async (req, res) => {
    try {
      const reconciliation =
        await financialReconciliationService.detectRaceDrift(req.params.raceId)

      return res.status(200).json({ reconciliation })
    } catch (error) {
      handleRouteError(error, res)
    }
  },
)

router.post('/races/:raceId', requireAdminApiToken, async (req, res) => {
  try {
    const settlement = await settlementService.settleRaceBets(req.params.raceId)
    return res.status(201).json({
      settlement: {
        raceId: settlement.raceId,
        winnerId: settlement.winnerId,
        settledAt: settlement.settledAt,
        processedCount: settlement.processedCount,
        wonCount: settlement.wonCount,
        lostCount: settlement.lostCount,
        totalPayoutMinor: settlement.totalPayoutMinor.toString(),
        settledBets: settlement.settledBets.map((entry) => ({
          bet: {
            id: entry.bet.id,
            userId: entry.bet.userId,
            walletId: entry.bet.walletId,
            raceId: entry.bet.raceId,
            currency: entry.bet.currency,
            betType: entry.bet.betType,
            selectionId: entry.bet.selectionId,
            stakeMinor: entry.bet.stakeMinor.toString(),
            payoutMinor:
              entry.bet.payoutMinor === null
                ? null
                : entry.bet.payoutMinor.toString(),
            status: entry.bet.status,
            resultStatus: entry.bet.resultStatus,
            placedAt: entry.bet.placedAt,
            settledAt: entry.bet.settledAt,
            refundedAt: entry.bet.refundedAt,
            metadata: entry.bet.metadata,
            createdAt: entry.bet.createdAt,
            updatedAt: entry.bet.updatedAt,
          },
          ledgerEntry: entry.ledgerEntry
            ? {
                id: entry.ledgerEntry.id,
                walletId: entry.ledgerEntry.walletId,
                entryType: entry.ledgerEntry.entryType,
                deltaMinor: entry.ledgerEntry.deltaMinor.toString(),
                balanceAfterMinor:
                  entry.ledgerEntry.balanceAfterMinor.toString(),
                referenceType: entry.ledgerEntry.referenceType,
                referenceId: entry.ledgerEntry.referenceId,
                metadata: entry.ledgerEntry.metadata,
                createdAt: entry.ledgerEntry.createdAt,
              }
            : null,
        })),
      },
    })
  } catch (error) {
    handleRouteError(error, res)
  }
})

export default router
