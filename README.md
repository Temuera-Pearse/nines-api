# nines-api

This repo is currently the player/API checkpoint service for Nines. It also
contains a holding area for non-race-authority code migrated out of
`nines-back-end`.

## Phase 1A Auth API

The active service exposes:

- `GET /health`
- `GET /auth/me`

`GET /auth/me` requires `Authorization: Bearer <access_token>` and validates
the token against Auth0 using the configured issuer, audience, and JWKS.
Authenticated users are treated as players and return:

```json
{
  "userId": "auth0|...",
  "authProvider": "auth0",
  "email": "player@example.com",
  "displayName": "Player One",
  "roles": ["player"]
}
```

Required runtime environment:

- `AUTH0_ISSUER` - Auth0 issuer URL, for example `https://tenant.region.auth0.com/`
- `AUTH0_AUDIENCE` - API identifier configured in Auth0

Local development loads `.env.local`, which should use:

```dotenv
AUTH0_ISSUER=https://nines-dev.au.auth0.com/
AUTH0_AUDIENCE=https://nines-api.local
```

The Auth0 tenant must define an API with the Identifier
`https://nines-api.local` and RS256 signing. Encrypted JWE tokens and signed
tokens using other algorithms are rejected with `401 invalid_token`.

Optional runtime environment:

- `PORT` - defaults to `3002`
- `CORS_ORIGIN` - comma-separated allowed browser origins, defaults to
  `http://localhost:5173,http://127.0.0.1:5173`

Local commands:

```bash
npm install
npm run dev
npm test
npm run typecheck
```

The migrated code is intentionally not wired, refactored, or production-ready
yet. It preserves useful source material for the future player/API gateway
service.

## Migrated Material

Backend code removed from `nines-back-end` lives under:

- `src/migrated-from-backend/users`
- `src/migrated-from-backend/wallets`
- `src/migrated-from-backend/bets`
- `src/migrated-from-backend/settlements`
- `src/migrated-from-backend/financial`
- `src/migrated-from-backend/admin`
- `db/migrations/migrated-from-backend`
- `docs/migrated-from-backend`

Expect imports to be broken until this repo is properly scaffolded and the code
is reviewed into real `nines-api` modules.

## Not Yet Done

- Betting is not wired here.
- Financial orchestration is not wired here.
- Migrated tests are preserved as source material, not an active test suite.
