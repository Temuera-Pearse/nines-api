import { Router } from 'express'
import type {
  MockHostedKycOutcomeResult,
  MockHostedKycService,
  MockHostedKycState,
  MockKycOutcome,
} from '../../kyc/application/MockHostedKycService.js'
import { AppError } from '../../shared/http/AppError.js'
import {
  type ContextRequest,
  requireRequestContext,
} from '../../shared/http/requestContext.js'

export interface MockHostedKycOperations {
  requirePendingSession(sessionId: string): Promise<MockHostedKycState>
  submitOutcome(
    sessionId: string,
    outcome: MockKycOutcome,
    correlationId: string,
  ): Promise<MockHostedKycOutcomeResult>
}

export function renderMockKycPage(sessionId: string): string {
  const encodedSessionId = JSON.stringify(sessionId)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mock KYC Provider</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07111f; color: #e5eefb; }
    main { width: min(100% - 32px, 460px); box-sizing: border-box; padding: 32px; border: 1px solid #2b405d; border-radius: 18px; background: #0d1b2e; box-shadow: 0 24px 70px #0008; }
    h1 { margin: 0 0 24px; font-size: 1.75rem; }
    p { line-height: 1.55; color: #c6d4e7; }
    .message { font-size: 1.08rem; color: #fff; }
    .actions { display: grid; gap: 12px; margin-top: 28px; }
    button { min-height: 48px; border: 1px solid #466486; border-radius: 10px; padding: 10px 16px; background: #172b46; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #213c60; }
    button:focus-visible { outline: 3px solid #60a5fa; outline-offset: 2px; }
    button[data-outcome="pass"] { background: #166534; border-color: #22c55e; }
    button[data-outcome="fail"] { background: #7f1d1d; border-color: #ef4444; }
    button:disabled { cursor: wait; opacity: .65; }
    #status { min-height: 24px; margin-top: 20px; color: #dbeafe; }
    #status.error { color: #fecaca; }
  </style>
</head>
<body>
  <main>
    <h1>Mock KYC Provider</h1>
    <p class="message">This is a mock KYC page.</p>
    <p class="message">For now, would you like to pass or fail verification?</p>
    <p>No identity documents are being collected. This page exists only to simulate an external KYC provider during development.</p>
    <div class="actions">
      <button type="button" data-outcome="pass">Pass verification</button>
      <button type="button" data-outcome="fail">Fail verification</button>
      <button type="button" id="cancel">Cancel</button>
    </div>
    <p id="status" role="status" aria-live="polite"></p>
  </main>
  <script>
    (() => {
      const sessionId = ${encodedSessionId};
      const status = document.getElementById('status');
      const buttons = [...document.querySelectorAll('button')];
      const notify = (message) => {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(message, '*');
        }
      };
      const setBusy = (busy) => {
        buttons.forEach((button) => { button.disabled = busy; });
      };
      document.querySelectorAll('[data-outcome]').forEach((button) => {
        button.addEventListener('click', async () => {
          const outcome = button.dataset.outcome;
          setBusy(true);
          status.className = '';
          status.textContent = 'Submitting verification result…';
          try {
            const response = await fetch(location.pathname + '/outcome', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ outcome }),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new Error(payload?.error?.message || 'Verification could not be completed');
            }
            const completedOutcome = payload.kycStatus === 'verified' ? 'pass' : 'fail';
            status.textContent = completedOutcome === 'pass'
              ? 'Verification passed. You may close this window.'
              : 'Verification failed. You may close this window.';
            notify({ type: 'nines:kyc-complete', sessionId, outcome: completedOutcome });
            window.setTimeout(() => window.close(), 700);
          } catch (error) {
            status.className = 'error';
            status.textContent = error instanceof Error
              ? error.message
              : 'Verification could not be completed';
            setBusy(false);
          }
        });
      });
      document.getElementById('cancel').addEventListener('click', () => {
        notify({ type: 'nines:kyc-cancelled', sessionId });
        window.close();
      });
    })();
  </script>
</body>
</html>`
}

export function createMockKycRouter(
  service: MockHostedKycOperations | MockHostedKycService,
): Router {
  const router = Router()
  router.get('/:sessionId', (request, response, next) => {
    void service
      .requirePendingSession(request.params.sessionId)
      .then(() => {
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        response.status(200).type('html').send(
          renderMockKycPage(request.params.sessionId),
        )
      })
      .catch(next)
  })
  router.post('/:sessionId/outcome', (request: ContextRequest, response, next) => {
    const outcome =
      request.body && typeof request.body === 'object'
        ? (request.body as { outcome?: unknown }).outcome
        : null
    if (outcome !== 'pass' && outcome !== 'fail') {
      next(
        new AppError({
          status: 400,
          code: 'KYC_MOCK_OUTCOME_INVALID',
          message: 'Mock KYC outcome must be pass or fail',
          publicMessage: 'Choose pass or fail',
        }),
      )
      return
    }
    const { correlationId } = requireRequestContext(request)
    void service
      .submitOutcome(request.params.sessionId, outcome, correlationId)
      .then((result) => response.status(200).json(result))
      .catch(next)
  })
  return router
}
