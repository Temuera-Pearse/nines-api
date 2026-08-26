import type { Pool } from 'pg'
import { AppError } from '../../shared/http/AppError.js'
import { toCryptoFundingPublicResult, type CryptoFundingPublicResult } from '../domain/CryptoFunding.js'
import type { CryptoFundingRepository } from '../infrastructure/CryptoFundingRepository.js'

export class GetCryptoFundingIntentService {
  constructor(private readonly pool: Pool, private readonly repository: CryptoFundingRepository) {}
  async get(playerId: string, intentId: string): Promise<CryptoFundingPublicResult> {
    const intent = await this.repository.findById(intentId, this.pool)
    if (!intent || intent.playerId !== playerId) throw new AppError({ status: 404, code: 'CRYPTO_FUNDING_INTENT_NOT_FOUND', message: 'Crypto funding intent was not found' })
    return toCryptoFundingPublicResult(intent)
  }
  async list(playerId: string): Promise<CryptoFundingPublicResult[]> {
    return (await this.repository.listForPlayer(playerId, 50, this.pool)).map(toCryptoFundingPublicResult)
  }
}
