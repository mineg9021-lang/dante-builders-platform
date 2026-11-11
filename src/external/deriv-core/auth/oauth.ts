import type { AuthConfig, AuthInfo, CallbackParams, TokenExchangeParams } from '../types';

export class OAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'OAuthError'; }
}

async function requestAuthorizationUrl(config: AuthConfig, mode: 'login' | 'signup'): Promise<string> {
  const response = await fetch('/.netlify/functions/deriv-oauth-start', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode, lang: config.lang, affiliateToken: config.affiliateToken,
      affiliateTokenParam: config.affiliateTokenParam, utmSource: config.utmSource,
      utmMedium: config.utmMedium, utmCampaign: config.utmCampaign,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.authorizationUrl !== 'string') {
    throw new OAuthError(result.message || 'Secure Deriv sign-in could not be started. Sign in to Dante Builders first.');
  }
  return result.authorizationUrl;
}

export const buildAuthorizationUrl = (config: AuthConfig): Promise<string> => requestAuthorizationUrl(config, 'login');
export const buildSignUpUrl = (config: AuthConfig): Promise<string> => requestAuthorizationUrl(config, 'signup');

export async function initiateLogin(config: AuthConfig): Promise<void> {
  window.location.assign(await buildAuthorizationUrl(config));
}
export async function initiateSignUp(config: AuthConfig): Promise<void> {
  window.location.assign(await buildSignUpUrl(config));
}

export function parseCallbackParams(url: string): CallbackParams {
  const parsed = new URL(url);
  return {
    code: parsed.searchParams.get('code'), state: parsed.searchParams.get('state'),
    scope: parsed.searchParams.get('scope'), error: parsed.searchParams.get('error'),
    error_description: parsed.searchParams.get('error_description'),
  };
}

/** Client-side presence check only; the backend validates the state against its encrypted HttpOnly transaction cookie. */
export function validateCallback(params: CallbackParams, _redirectUri: string): string {
  if (params.error) throw new OAuthError(params.error_description || params.error);
  if (!params.code || !params.state) throw new OAuthError('OAuth callback is missing code or state');
  return params.code;
}

/** Direct browser token exchange is disabled by design. */
export async function exchangeCodeForTokens(_params: TokenExchangeParams): Promise<AuthInfo> {
  throw new OAuthError('Direct browser token exchange is disabled; use the secure server callback.');
}
export async function refreshAccessToken(_refreshToken: string, _clientId: string): Promise<AuthInfo> {
  throw new OAuthError('Deriv OAuth sessions must be reauthorized after expiry.');
}

function assertCallbackLocation(callbackUrl: string, redirectUri: string): void {
  try {
    const callback = new URL(callbackUrl), expected = new URL(redirectUri);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
      throw new OAuthError('OAuth callback URL does not match the configured redirect URI');
    }
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError('OAuth callback URL or configured redirect URI is invalid');
  }
}

export async function handleOAuthCallback(callbackUrl: string, config: AuthConfig): Promise<void> {
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

export function cleanupUrl(_baseUrl: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  ['code', 'state', 'scope', 'error', 'error_description'].forEach(param => url.searchParams.delete(param));
  window.history.replaceState(window.history.state, '', url.pathname + url.search);
}
