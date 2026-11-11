import type { AuthInfo, DerivAccount } from '../types';
import {
  storeDerivAccounts, getDerivAccounts, getActiveLoginId, setActiveLoginId,
  setAccountType, clearAllAuthData,
} from './storage';

/** Select only an account present in the latest server-verified account list. */
export function selectDerivAccount(accountId: string, availableAccounts: DerivAccount[] | null = getDerivAccounts()): DerivAccount {
  const account = availableAccounts?.find(item => item.account_id === accountId);
  if (!account) throw new Error('Selected Deriv account is not available in the authenticated account list');
  setActiveLoginId(account.account_id);
  setAccountType(account.account_type);
  return account;
}

/** Fetch account metadata through Dante's authenticated backend; no bearer token reaches the browser. */
export async function fetchAccounts(_authInfo?: AuthInfo, _clientId?: string): Promise<DerivAccount[]> {
  const response = await fetch('/.netlify/functions/deriv-accounts', { credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to fetch Deriv accounts');
  const accounts = payload.data;
  if (!Array.isArray(accounts)) throw new Error('Deriv returned an invalid accounts response');
  storeDerivAccounts(accounts);
  if (accounts.length > 0) {
    const activeLoginId = getActiveLoginId();
    const selected = activeLoginId ? accounts.find((account: DerivAccount) => account.account_id === activeLoginId) : undefined;
    selectDerivAccount((selected ?? accounts[0]).account_id, accounts);
  }
  return accounts;
}

/** Request a one-time WebSocket URL; the server rechecks account ownership against Deriv. */
export async function getWebSocketOTP(accountId: string, _authInfo?: AuthInfo, _clientId?: string): Promise<string> {
  const available = getDerivAccounts();
  if (!available?.some(account => account.account_id === accountId)) {
    throw new Error('Cannot authorize a WebSocket for an account outside the authenticated account list');
  }
  const response = await fetch('/.netlify/functions/deriv-account-otp', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.url !== 'string') throw new Error(payload.error || 'Failed to get WebSocket OTP');
  if (payload.account?.account_type === 'demo' || payload.account?.account_type === 'real') setAccountType(payload.account.account_type);
  return payload.url;
}

/** Clear local display state. Dante logout also revokes the server-side Deriv vault separately. */
export function logout(): void { clearAllAuthData(); }
