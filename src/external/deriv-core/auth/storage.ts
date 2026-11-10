import type { AuthInfo, DerivAccount, StoredCSRFToken, StoredCodeVerifier } from '../types';

const CSRF_TOKEN_KEY = 'oauth_csrf_token';
const CODE_VERIFIER_KEY = 'oauth_code_verifier';
const AUTH_INFO_KEY = 'auth_info';
const DERIV_ACCOUNTS_KEY = 'deriv_accounts';
const ACTIVE_LOGINID_KEY = 'active_loginid';
const ACCOUNT_TYPE_KEY = 'account_type';

const TOKEN_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function isFreshTransientValue(value: unknown): value is { value: string; createdAt: number } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { value?: unknown; createdAt?: unknown };
  if (typeof candidate.value !== 'string' || !candidate.value) return false;
  if (typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt)) return false;
  const age = Date.now() - candidate.createdAt;
  return age >= 0 && age <= TOKEN_MAX_AGE_MS;
}

// --- CSRF Token ---

export function storeCSRFToken(token: string): void {
  const stored: StoredCSRFToken = { value: token, createdAt: Date.now() };
  sessionStorage.setItem(CSRF_TOKEN_KEY, JSON.stringify(stored));
}

export function getCSRFToken(): string | null {
  const raw = sessionStorage.getItem(CSRF_TOKEN_KEY);
  if (!raw) return null;

  try {
    const stored: unknown = JSON.parse(raw);
    if (!isFreshTransientValue(stored)) {
      clearCSRFToken();
      return null;
    }
    return stored.value;
  } catch {
    clearCSRFToken();
    return null;
  }
}

export function clearCSRFToken(): void {
  sessionStorage.removeItem(CSRF_TOKEN_KEY);
}

// --- PKCE Code Verifier ---

export function storeCodeVerifier(verifier: string): void {
  const stored: StoredCodeVerifier = { value: verifier, createdAt: Date.now() };
  sessionStorage.setItem(CODE_VERIFIER_KEY, JSON.stringify(stored));
}

export function getCodeVerifier(): string | null {
  const raw = sessionStorage.getItem(CODE_VERIFIER_KEY);
  if (!raw) return null;

  try {
    const stored: unknown = JSON.parse(raw);
    if (!isFreshTransientValue(stored)) {
      clearCodeVerifier();
      return null;
    }
    return stored.value;
  } catch {
    clearCodeVerifier();
    return null;
  }
}

export function clearCodeVerifier(): void {
  sessionStorage.removeItem(CODE_VERIFIER_KEY);
}

// --- Auth Info ---

export function storeAuthInfo(authInfo: AuthInfo): void {
  localStorage.setItem(AUTH_INFO_KEY, JSON.stringify(authInfo));
}

export function getAuthInfo(): AuthInfo | null {
  const raw = localStorage.getItem(AUTH_INFO_KEY);
  if (!raw) return null;

  try {
    const authInfo: unknown = JSON.parse(raw);
    if (
      !authInfo ||
      typeof authInfo !== 'object' ||
      typeof (authInfo as AuthInfo).access_token !== 'string' ||
      !(authInfo as AuthInfo).access_token ||
      typeof (authInfo as AuthInfo).expires_at !== 'number' ||
      !Number.isFinite((authInfo as AuthInfo).expires_at) ||
      (authInfo as AuthInfo).expires_at <= 0 ||
      Date.now() >= (authInfo as AuthInfo).expires_at * 1000
    ) {
      clearAuthInfo();
      return null;
    }
    return authInfo as AuthInfo;
  } catch {
    clearAuthInfo();
    return null;
  }
}

export function clearAuthInfo(): void {
  localStorage.removeItem(AUTH_INFO_KEY);
}

// --- Deriv Accounts ---

export function storeDerivAccounts(accounts: DerivAccount[]): void {
  localStorage.setItem(DERIV_ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function getDerivAccounts(): DerivAccount[] | null {
  const raw = localStorage.getItem(DERIV_ACCOUNTS_KEY);
  if (!raw) return null;
  try {
    const accounts: unknown = JSON.parse(raw);
    if (!Array.isArray(accounts)) {
      clearDerivAccounts();
      return null;
    }
    return accounts as DerivAccount[];
  } catch {
    clearDerivAccounts();
    return null;
  }
}

export function clearDerivAccounts(): void {
  localStorage.removeItem(DERIV_ACCOUNTS_KEY);
}

// --- Active Login ID (localStorage) ---

export function setActiveLoginId(loginId: string): void {
  localStorage.setItem(ACTIVE_LOGINID_KEY, loginId);
}

export function getActiveLoginId(): string | null {
  return localStorage.getItem(ACTIVE_LOGINID_KEY);
}

// --- Account Type (localStorage) ---

export function setAccountType(type: 'demo' | 'real'): void {
  localStorage.setItem(ACCOUNT_TYPE_KEY, type);
}

export function getAccountType(): string | null {
  return localStorage.getItem(ACCOUNT_TYPE_KEY);
}

// --- Clear All Auth Data ---

export function clearAllAuthData(): void {
  clearCSRFToken();
  clearCodeVerifier();
  clearAuthInfo();
  clearDerivAccounts();
  localStorage.removeItem(ACTIVE_LOGINID_KEY);
  localStorage.removeItem(ACCOUNT_TYPE_KEY);
}
