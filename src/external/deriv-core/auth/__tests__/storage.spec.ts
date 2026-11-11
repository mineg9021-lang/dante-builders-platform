import {
  getAuthInfo, getStoredAuthInfo, getCodeVerifier, getCSRFToken,
  getDerivAccounts, storeAuthInfo, storeCodeVerifier, storeCSRFToken,
  storeDerivAccounts,
} from '../storage';
import type { AuthInfo, DerivAccount } from '../../types';

const legacyAuth: AuthInfo = {
  access_token: 'must-not-persist', token_type: 'Bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, scope: 'trade',
  refresh_token: 'legacy-refresh-token',
};
const validAccount: DerivAccount = {
  account_id: 'VRTC12345', account_type: 'demo', currency: 'USD',
  balance: '10000.00', group: 'financial', status: 'active',
};

describe('OAuth browser storage boundary', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  it('stores only short-lived OAuth state and verifier in session storage', () => {
    storeCSRFToken('csrf-value'); storeCodeVerifier('pkce-verifier');
    expect(getCSRFToken()).toBe('csrf-value');
    expect(getCodeVerifier()).toBe('pkce-verifier');
  });
  it('clears malformed transient OAuth values safely', () => {
    sessionStorage.setItem('oauth_csrf_token', '{invalid');
    sessionStorage.setItem('oauth_code_verifier', '{invalid');
    expect(getCSRFToken()).toBeNull(); expect(getCodeVerifier()).toBeNull();
  });
  it('never persists access or refresh tokens in browser storage', () => {
    storeAuthInfo(legacyAuth);
    expect(getAuthInfo()).toBeNull();
    expect(getStoredAuthInfo()).toBeNull();
    expect(localStorage.getItem('auth_info')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('must-not-persist');
  });
  it('keeps non-secret account display metadata available for selection', () => {
    storeDerivAccounts([validAccount]);
    expect(getDerivAccounts()).toEqual([validAccount]);
  });
  it('clears malformed or non-array account metadata', () => {
    localStorage.setItem('deriv_accounts', '{invalid');
    expect(getDerivAccounts()).toBeNull();
    localStorage.setItem('deriv_accounts', JSON.stringify({ account_id: 'VRTC12345' }));
    expect(getDerivAccounts()).toBeNull();
  });
});
