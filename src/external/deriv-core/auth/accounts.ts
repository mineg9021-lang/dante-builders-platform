import type { AuthInfo, DerivAccount, OTPResponse } from '../types';
import {
  storeDerivAccounts,
  getDerivAccounts,
  getActiveLoginId,
  setActiveLoginId,
  setAccountType,
  clearAllAuthData,
} from './storage';
import { getApiBaseUrl } from '../config/urls';

/**
 * Select one account returned by Deriv. The account type is always derived
 * from Deriv's account record; callers cannot relabel a real account as demo
 * or a demo account as real.
 */
export function selectDerivAccount(
  accountId: string,
  availableAccounts: DerivAccount[] | null = getDerivAccounts()
): DerivAccount {
  const account = availableAccounts?.find(item => item.account_id === accountId);
  if (!account) {
    throw new Error('Selected Deriv account is not available in the authenticated account list');
  }

  setActiveLoginId(account.account_id);
  setAccountType(account.account_type);
  return account;
}

/**
 * Fetch the list of trading accounts for the authenticated user.
 * Keep the user's selected account when it is still available. Only choose
 * Deriv's first returned account when there is no valid previous selection.
 */
export async function fetchAccounts(
  authInfo: AuthInfo,
  clientId: string
): Promise<DerivAccount[]> {
  const response = await fetch(`${getApiBaseUrl()}/accounts`, {
    headers: {
      Authorization: `Bearer ${authInfo.access_token}`,
      'Deriv-App-ID': clientId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch accounts (${response.status})`);
  }

  const data = await response.json();
  const accounts: DerivAccount[] = data.data;

  if (!Array.isArray(accounts)) {
    throw new Error('Deriv returned an invalid accounts response');
  }

  storeDerivAccounts(accounts);

  if (accounts.length > 0) {
    const activeLoginId = getActiveLoginId();
    const selected = activeLoginId
      ? accounts.find(account => account.account_id === activeLoginId)
      : undefined;
    selectDerivAccount((selected ?? accounts[0]).account_id, accounts);
  }

  return accounts;
}

/**
 * Get a one-time WebSocket URL for an authenticated session.
 */
export async function getWebSocketOTP(
  accountId: string,
  authInfo: AuthInfo,
  clientId: string
): Promise<string> {
  const availableAccounts = getDerivAccounts();
  if (!availableAccounts?.some(account => account.account_id === accountId)) {
    throw new Error('Cannot authorize a WebSocket for an account outside the authenticated account list');
  }

  const response = await fetch(`${getApiBaseUrl()}/accounts/${encodeURIComponent(accountId)}/otp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authInfo.access_token}`,
      'Deriv-App-ID': clientId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get WebSocket OTP (${response.status})`);
  }

  const data: OTPResponse = await response.json();
  return data.data.url;
}

/**
 * Perform logout: clear all auth data.
 * Caller is responsible for closing any open WebSocket connections and resetting UI.
 */
export function logout(): void {
  clearAllAuthData();
}
