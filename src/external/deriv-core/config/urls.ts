type DerivEnv = 'production' | 'preview';

function getEnv(): DerivEnv {
  // `process.env.NEXT_PUBLIC_DERIV_ENV` is statically replaced at build time by
  // rsbuild's `source.define`. Do NOT guard on `typeof process` — the bare
  // `process` identifier is not defined, so it is `'undefined'` in the browser
  // and would short-circuit this to the production fallback even on staging.
  return process.env.NEXT_PUBLIC_DERIV_ENV === 'preview' ? 'preview' : 'production';
}

const URLS = {
  production: {
    authBase: 'https://auth.deriv.com/oauth2',
    apiBase: 'https://api.derivws.com/trading/v1/options',
    publicWs: 'wss://api.derivws.com/trading/v1/options/ws/public',
    appBuilder: 'https://developers.deriv.com',
  },
  preview: {
    authBase: 'https://staging-auth.deriv.com/oauth2',
    apiBase: 'https://staging-api.derivws.com/trading/v1/options',
    publicWs: 'wss://staging-api.derivws.com/trading/v1/options/ws/public',
    appBuilder: 'https://staging-developers.deriv.com',
  },
} as const;

export function getAuthBaseUrl(): string {
  return URLS[getEnv()].authBase;
}

export function getApiBaseUrl(): string {
  return URLS[getEnv()].apiBase;
}

export function getPublicWsUrl(): string {
  return URLS[getEnv()].publicWs;
}

/**
 * Base URL of the app-builder BFF (deriv-api-v2), used to call its runtime
 * affiliate-resolution proxy. Derived from NEXT_PUBLIC_DERIV_ENV.
 */
export function getAppBuilderBaseUrl(): string {
  return URLS[getEnv()].appBuilder;
}


/**
 * Keep the OAuth redirect URI identical during authorization and token exchange.
 * Set NEXT_PUBLIC_DERIV_REDIRECT_URI only when it exactly matches a URI registered
 * for this OAuth client. The production site root remains the safe default.
 */
export function getOAuthRedirectUri(): string {
  const configured = process.env.NEXT_PUBLIC_DERIV_REDIRECT_URI?.trim();
  return configured || window.location.origin;
}
