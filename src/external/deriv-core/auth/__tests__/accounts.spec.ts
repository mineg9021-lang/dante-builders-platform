import {
  fetchAccounts,
  getWebSocketOTP,
  selectDerivAccount,
} from '../accounts';
import {
  getAccountType,
  getActiveLoginId,
  storeDerivAccounts,
} from '../storage';
import type { AuthInfo, DerivAccount } from '../../types';

jest.mock('../../config/urls', () => ({
  getApiBaseUrl: () => 'https://api.derivws.com/trading/v1/options',
}));

const authInfo: AuthInfo = {
  access_token: 'deriv-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: 4_000_000_000,
  scope: 'trade',
  refresh_token: 'deriv-refresh-token',
};

const accounts: DerivAccount[] = [
  {
    account_id: 'VRTC12345',
    account_type: 'demo',
    currency: 'USD',
    balance: '10000.00',
    group: 'financial',
    status: 'active',
  },
  {
    account_id: 'CRW12345',
    account_type: 'real',
    currency: 'USD',
    balance: '25.00',
    group: 'financial',
    status: 'active',
  },
];

describe('Deriv demo and real account selection', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('keeps the previously selected real account when accounts are refreshed', async () => {
    storeDerivAccounts(accounts);
    selectDerivAccount('CRW12345', accounts);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: accounts }),
    });

    await fetchAccounts(authInfo, 'test-app-id');

    expect(getActiveLoginId()).toBe('CRW12345');
    expect(getAccountType()).toBe('real');
  });

  it('selects the first Deriv account only when no account was selected', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: accounts }),
    });

    await fetchAccounts(authInfo, 'test-app-id');

    expect(getActiveLoginId()).toBe('VRTC12345');
    expect(getAccountType()).toBe('demo');
  });

  it.each([
    ['VRTC12345', 'demo'],
    ['CRW12345', 'real'],
  ] as const)('sets account type from Deriv when selecting %s', (accountId, type) => {
    storeDerivAccounts(accounts);

    const selected = selectDerivAccount(accountId);

    expect(selected.account_type).toBe(type);
    expect(getActiveLoginId()).toBe(accountId);
    expect(getAccountType()).toBe(type);
  });

  it('rejects an account that is not in the authenticated account list', () => {
    storeDerivAccounts(accounts);

    expect(() => selectDerivAccount('UNKNOWN')).toThrow(
      'Selected Deriv account is not available in the authenticated account list'
    );
    expect(getActiveLoginId()).toBeNull();
  });

  it('does not request a WebSocket OTP for an account outside the account list', async () => {
    storeDerivAccounts(accounts);

    await expect(getWebSocketOTP('UNKNOWN', authInfo, 'test-app-id')).rejects.toThrow(
      'Cannot authorize a WebSocket for an account outside the authenticated account list'
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('requests a fresh WebSocket OTP for the selected real account', async () => {
    storeDerivAccounts(accounts);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { url: 'wss://example.derivws.com/session' } }),
    });

    await expect(getWebSocketOTP('CRW12345', authInfo, 'test-app-id')).resolves.toBe(
      'wss://example.derivws.com/session'
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.derivws.com/trading/v1/options/accounts/CRW12345/otp',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer deriv-access-token',
          'Deriv-App-ID': 'test-app-id',
        }),
      })
    );
  });
});
