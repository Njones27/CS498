import { ApiError } from '../api/client'
import type { Session } from './session'

export const UNAVAILABLE_MESSAGE = 'Sign-in is unavailable right now. Try again in a moment.'
export const NEW_PASSWORD_MESSAGE =
  'This account needs a new password before it can sign in. Ask an administrator to set one.'
export const LOCKED_OUT_MESSAGE = 'Too many failed sign-in attempts. Wait a few minutes and try again.'

interface InitiateAuthBody {
  AuthenticationResult?: { IdToken?: string }
  ChallengeName?: string
  __type?: string
  message?: string
}

/**
 * Build a session from a Cognito ID token's payload. The signature is not checked here: the API
 * verifies the token on every request, so this only reads the claims the UI needs.
 */
export function sessionFromIdToken(idToken: string): Session | null {
  try {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')), (c) =>
      c.charCodeAt(0),
    )
    const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!claims || typeof claims !== 'object') return null
    const { email, exp, 'cognito:groups': groups } = claims as Record<string, unknown>
    if (typeof email !== 'string' || !email || typeof exp !== 'number' || !Number.isFinite(exp)) return null
    return {
      token: idToken,
      email,
      groups: Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [],
      expiresAt: new Date(exp * 1000).toISOString(),
    }
  } catch {
    return null
  }
}

function signInError(body: InitiateAuthBody): Error {
  const type = body.__type?.split('#').pop()
  if (type === 'PasswordResetRequiredException') return new Error(NEW_PASSWORD_MESSAGE)
  if (type === 'NotAuthorizedException' && /attempts exceeded/i.test(body.message ?? '')) {
    return new Error(LOCKED_OUT_MESSAGE)
  }
  if (type === 'NotAuthorizedException' || type === 'UserNotFoundException') {
    return new ApiError(401, { error: 'invalid_credentials', message: 'Email or password is incorrect' })
  }
  return new Error(UNAVAILABLE_MESSAGE)
}

/** Sign in at the user pool itself (USER_PASSWORD_AUTH); the password never reaches our API. */
export async function signInWithCognito(
  region: string,
  clientId: string,
  email: string,
  password: string,
): Promise<Session> {
  // The region comes from our API and becomes part of a hostname: only ever an AWS region name.
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(UNAVAILABLE_MESSAGE)
  let res: Response
  let body: InitiateAuthBody
  try {
    res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    })
    body = (await res.json()) as InitiateAuthBody
  } catch {
    throw new Error(UNAVAILABLE_MESSAGE)
  }
  if (!body || typeof body !== 'object') throw new Error(UNAVAILABLE_MESSAGE)
  if (!res.ok) throw signInError(body)
  // Only a forced password change gets its own message; other challenges (MFA) are not set up.
  if (body.ChallengeName === 'NEW_PASSWORD_REQUIRED') throw new Error(NEW_PASSWORD_MESSAGE)
  const idToken = body.AuthenticationResult?.IdToken
  const session = idToken ? sessionFromIdToken(idToken) : null
  if (!session) throw new Error(UNAVAILABLE_MESSAGE)
  return session
}
