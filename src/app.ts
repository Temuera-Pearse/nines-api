import express from 'express'
import authRoutes from './auth/authRoutes.js'

const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

export function getAllowedCorsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.CORS_ORIGIN ?? LOCAL_DEV_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export function createCorsMiddleware(
  env: NodeJS.ProcessEnv = process.env,
): express.RequestHandler {
  const allowedOrigins = getAllowedCorsOrigins(env)

  return (req, res, next) => {
    const origin = req.header('origin')
    if (
      origin &&
      (allowedOrigins.includes('*') || allowedOrigins.includes(origin))
    ) {
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Vary', 'Origin')
    }

    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS')

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204)
    }

    return next()
  }
}

function applyCors(app: express.Express, env: NodeJS.ProcessEnv) {
  app.use(createCorsMiddleware(env))
}

export function createApp(env: NodeJS.ProcessEnv = process.env) {
  const app = express()

  applyCors(app, env)
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'nines-api' })
  })

  app.use('/auth', authRoutes)

  return app
}
