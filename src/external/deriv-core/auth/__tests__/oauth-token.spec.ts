import { exchangeCodeForTokens, refreshAccessToken, OAuthError } from '../oauth';
import { getAuthInfo, storeAuthInfo, storeCodeVerifier } from '../storage';
import type { AuthInfo } from '../../types';

const validTokenResponse = {
  access_token: 'new-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  scope: 'trade',
  refresh_token: 'new-refresh-token',
};

function mockTokenResponse(payload: unknown, ok = true): void {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => payload,
    text: async () => 'provider error details',
  } as Response);
}

const exchangeParams = {
  code: 'authorization-code',
  clientId: 'app-id',
  redirectUri: 'https://partner.example.com',
  codeVerifier: 'pkce-verifier',
};

const storedAuth: AuthInfo = {
  ...validTokenResponse,
  access_token: 'old-access-token',
  refresh_token: 'old-refresh-token',
};

describe('OAuth token response validation', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    jest.restoreAllMocks();
  });

  it('stores a valid authorization-code token response', async () => {
    mockTokenResponse(validTokenResponse);
    storeCodeVerifier('pkce-verifier');

    const result = await exchangeCodeForTokens(exchangeParams);

    expect(result).toMatchObject(validTokenResponse);
    expect(getAuthInfo()).toEqual(result);
    expect(sessionStorage.getItem('oauth_code_verifier')).toBeNull();
  });

  it.each([
    ['missing access token', { ...validTokenResponse, access_token: '' }],
    ['unsupported token type', { ...validTokenResponse, token_type: 'mac' }],
    ['missing token type', (() => { const value = { ...validTokenResponse }; delete (value as { token_type?: string }).token_type; return value; })()],
    ['zero expiry duration', { ...validTokenResponse, expires_in: 0 }],
    ['non-finite expiry duration', { ...validTokenResponse, expires_in: Number.NaN }],
    ['expired expiry timestamp', { ...validTokenResponse, expires_at: 1 }],
    ['invalid expiry timestamp', { ...validTokenResponse, expires_at: 'later' }],
    ['missing refresh token', { ...validTokenResponse, refresh_token: '' }],
    ['invalid scope', { ...validTokenResponse, scope: 42 }],
  ])('rejects %s without persisting credentials', async (_label, payload) => {
    mockTokenResponse(payload);

    await expect(exchangeCodeForTokens(exchangeParams)).rejects.toBeInstanceOf(OAuthError);
    expect(getAuthInfo()).toBeNull();
  });

  it('does not expose provider error bodies when token exchange fails', async () => {
    mockTokenResponse({ error: 'invalid_grant', error_description: 'provider error details' }, false);

    await expect(exchangeCodeForTokens(exchangeParams)).rejects.toThrow('Token exchange failed (400)');
    await expect(exchangeCodeForTokens(exchangeParams)).rejects.not.toThrow('provider error details');
    expect(getAuthInfo()).toBeNull();
  });

  it('rejects invalid JSON and does not expose provider response details', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json'); },
    } as unknown as Response);

    await expect(exchangeCodeForTokens(exchangeParams)).rejects.toThrow('Token exchange returned invalid JSON');
    expect(getAuthInfo()).toBeNull();
  });

  it('retains the existing refresh token when a refresh response rotates neither token nor scope', async () => {
    storeAuthInfo(storedAuth);
    mockTokenResponse({
      access_token: 'refreshed-access-token',
      token_type: 'Bearer',
      expires_in: 1800,
    });

    const result = await refreshAccessToken('old-refresh-token', 'app-id');

    expect(result.access_token).toBe('refreshed-access-token');
    expect(result.refresh_token).toBe('old-refresh-token');
    expect(result.scope).toBe('trade');
    expect(getAuthInfo()).toEqual(result);
  });

  it('uses a newly issued refresh token and scope when supplied', async () => {
    mockTokenResponse({
      ...validTokenResponse,
      access_token: 'refreshed-access-token',
      refresh_token: 'rotated-refresh-token',
      scope: 'trade payments',
    });

    const result = await refreshAccessToken('old-refresh-token', 'app-id');

    expect(result.refresh_token).toBe('rotated-refresh-token');
    expect(result.scope).toBe('trade payments');
  });

  it('preserves stored credentials when a refresh response is invalid', async () => {
    storeAuthInfo(storedAuth);
    mockTokenResponse({ access_token: 'missing-required-fields' });

    await expect(refreshAccessToken('old-refresh-token', 'app-id')).rejects.toBeInstanceOf(OAuthError);
    expect(getAuthInfo()).toEqual(storedAuth);
  });
});
