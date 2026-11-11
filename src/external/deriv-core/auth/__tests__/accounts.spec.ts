import { fetchAccounts, getWebSocketOTP, selectDerivAccount } from '../accounts';
import { getAccountType, getActiveLoginId, storeDerivAccounts } from '../storage';
import type { DerivAccount } from '../../types';

const accounts: DerivAccount[] = [
  { account_id: 'VRTC12345', account_type: 'demo', currency: 'USD', balance: '10000.00', group: 'financial', status: 'active' },
  { account_id: 'CRW12345', account_type: 'real', currency: 'USD', balance: '25.00', group: 'financial', status: 'active' },
];

describe('Deriv account backend boundary', () => {
  beforeEach(() => { localStorage.clear(); jest.clearAllMocks(); });
  it('keeps a previously selected account when the backend refreshes account metadata', async () => {
    storeDerivAccounts(accounts); selectDerivAccount('CRW12345', accounts);
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ data: accounts }) });
    await fetchAccounts();
    expect(getActiveLoginId()).toBe('CRW12345');
    expect(getAccountType()).toBe('real');
    expect(fetch).toHaveBeenCalledWith('/.netlify/functions/deriv-accounts', { credentials: 'same-origin' });
  });
  it('selects the first verified account only when none was selected', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ data: accounts }) });
    await fetchAccounts();
    expect(getActiveLoginId()).toBe('VRTC12345');
    expect(getAccountType()).toBe('demo');
  });
  it('rejects account selection outside the known account list', () => {
    storeDerivAccounts(accounts);
    expect(() => selectDerivAccount('UNKNOWN')).toThrow('Selected Deriv account is not available in the authenticated account list');
  });
  it('does not request a WebSocket OTP for an account outside the known list', async () => {
    storeDerivAccounts(accounts);
    await expect(getWebSocketOTP('UNKNOWN')).rejects.toThrow('Cannot authorize a WebSocket for an account outside the authenticated account list');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requests a WebSocket URL through the authenticated backend, not with a bearer token', async () => {
    storeDerivAccounts(accounts);
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'wss://example.derivws.com/session', account: { account_type: 'real' } }) });
    await expect(getWebSocketOTP('CRW12345')).resolves.toBe('wss://example.derivws.com/session');
    expect(fetch).toHaveBeenCalledWith('/.netlify/functions/deriv-account-otp', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ accountId: 'CRW12345' }),
    }));
  });
});
