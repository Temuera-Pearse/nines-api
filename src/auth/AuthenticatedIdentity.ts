export interface AuthenticatedIdentity {
  provider: 'auth0'
  issuer: string
  subject: string
  email: string | null
  emailVerified: boolean | null
  displayName: string | null
  tokenType: 'human'
}
