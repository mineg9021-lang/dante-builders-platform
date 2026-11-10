import {
  getAuthInfo,
  getCodeVerifier,
  getCSRFToken,
  getDerivAccounts,
  storeAuthInfo,
  storeCodeVerifier,
  storeCSRFToken,
  storeDerivAccounts,
} from '../storage';
import type { AuthInfo, DerivAccount } from '../../types';

const validAuthInfo: AuthInfo = {
  access_token: 'access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  scope: 'trade',
  refresh_token: 'refresh-token',
};

const validAccount: DerivAccount = {
  account_id: 'VRTC12345',
  account_type: 'demo',
  currency: 'USD',
  balance: '10000.00',
  group: 'financial',
  status: 'active',
};

describe('OAuth and Deriv browser storage validation', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('reads a fresh CSRF token and PKCE verifier', () => {
    storeCSRFToken('csrf-value');
    storeCodeVerifier('pkce-verifier');

    expect(getCSRFToken()).toBe('csrf-value');
    expect(getCodeVerifier()).toBe('pkce-verifier');
  });

  it('clears malformed CSRF and PKCE storage instead of throwing', () => {
    sessionStorage.setItem('oauth_csrf_token', '{invalid');
    sessionStorage.setItem('oauth_code_verifier', '{invalid');

    expect(() => getCSRFToken()).not.toThrow();
    expect(() => getCodeVerifier()).not.toThrow();
    expect(sessionStorage.getItem('oauth_csrf_token')).toBeNull();
    expect(sessionStorage.getItem('oauth_code_verifier')).toBeNull();
  });

  it('rejects expired or future-dated transient OAuth values', () => {
    sessionStorage.setItem('oauth_csrf_token', JSON.stringify({
      value: 'expired',
      createdAt: Date.now() - 11 * 60 * 1000,
    }));
    sessionStorage.setItem('oauth_code_verifier', JSON.stringify({
      value: 'future',
      createdAt: Date.now() + 60_000,
    }));

    expect(getCSRFToken()).toBeNull();
    expect(getCodeVerifier()).toBeNull();
  });

  it('reads a valid unexpired auth record', () => {
    storeAuthInfo(validAuthInfo);

    expect(getAuthInfo()).toEqual(validAuthInfo);
  });

  it.each([
    ['malformed JSON', '{invalid'],
    ['missing expiry', JSON.stringify({ access_token: 'token' })],
    ['invalid expiry', JSON.stringify({ access_token: 'token', expires_at: 'later' })],
    ['expired token', JSON.stringify({ access_token: 'token', expires_at: 1 })],
  ])('clears an auth record with %s', (_label, raw) => {
    localStorage.setItem('auth_info', raw);

    expect(getAuthInfo()).toBeNull();
    expect(localStorage.getItem('auth_info')).toBeNull();
  });

  it('reads a valid Deriv account list', () => {
    storeDerivAccounts([validAccount]);

    expect(getDerivAccounts()).toEqual([validAccount]);
  });

  it('clears malformed or non-array Deriv account storage', () => {
    localStorage.setItem('deriv_accounts', '{invalid');
    expect(getDerivAccounts()).toBeNull();
    expect(localStorage.getItem('deriv_accounts')).toBeNull();

    localStorage.setItem('deriv_accounts', JSON.stringify({ account_id: 'VRTC12345' }));
    expect(getDerivAccounts()).toBeNull();
    expect(localStorage.getItem('deriv_accounts')).toBeNull();
  });
});
