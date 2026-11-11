import type { AuthConfig, AuthInfo, CallbackParams, TokenExchangeParams } from '../types';
import { generateRandomBase64url } from './crypto';
import {
  clearAllAuthData,
} from './storage';
import { getAuthBaseUrl } from '../config/urls';

/**
 * Build the base PKCE URLSearchParams shared by login and sign-up.
 * Stores a fresh CSRF token and code verifier in sessionStorage.
 */
async function requestAuthorizationUrl(config: AuthConfig, mode: 'login' | 'signup'): Promise<string> {
  const response = await fetch('/.netlify/functions/deriv-oauth-start', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode, lang: config.lang, affiliateToken: config.affiliateToken,
      affiliateTokenParam: config.affiliateTokenParam,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.authorizationUrl !== 'string') {
    throw new OAuthError(result.message || 'Secure Deriv sign-in could not be started. Sign in to Dante Builders first.');
  }
  return result.authorizationUrl;
}

/** Start login through the server-held PKCE transaction. */
export async function buildAuthorizationUrl(config: AuthConfig): Promise<string> {
  return requestAuthorizationUrl(config, 'login');
}

/** Start registration through the server-held PKCE transaction. */
export async function buildSignUpUrl(config: AuthConfig): Promise<string> {
  return requestAuthorizationUrl(config, 'signup');
}

/**
 * Direct browser token exchange is intentionally disabled. Deriv credentials
 * are exchanged and stored only by the authenticated Netlify callback.
 */
export async function exchangeCodeForTokens(_params: TokenExchangeParams): Promise<AuthInfo> {
  throw new OAuthError('Direct browser token exchange is disabled; use the secure server callback.');
}

/** Deriv third-party OAuth does not issue refresh tokens. Reauthorization is required on expiry. */
export async function refreshAccessToken(_refreshToken: string, _clientId: string): Promise<AuthInfo> {
  throw new OAuthError('Deriv OAuth sessions must be reauthorized after expiry.');
}

export async function handleOAuthCallback(
  callbackUrl: string,
  config: AuthConfig
): Promise<void> {
  assertCallbackLocation(callbackUrl, config.redirectUri);
  const params = parseCallbackParams(callbackUrl);
  if (params.error) throw new OAuthError(params.error_description || params.error);
  if (!params.code || !params.state) throw new OAuthError('OAuth callback is missing code or state');
  const response = await fetch('/.netlify/functions/deriv-oauth-callback', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: params.code, state: params.state }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.connected !== true) {
    throw new OAuthError(result.error === 'OAUTH_TRANSACTION_EXPIRED'
      ? 'The Deriv sign-in expired. Please connect again.'
      : 'Deriv connection could not be completed. Please try again.');
  }
  cleanupUrl(config.redirectUri);
}


