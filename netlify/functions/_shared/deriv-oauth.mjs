import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const COOKIE = 'dante_deriv_oauth_tx';
const SESSION_COOKIE = 'dante_account_session';
const COOKIE_OPTIONS = 'Path=/; HttpOnly; Secure; SameSite=Lax';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const b64url = value => Buffer.from(value).toString('base64url');
const fromB64url = value => Buffer.from(value, 'base64url');

function encryptionKey() {
  const raw = process.env.DERIV_TOKEN_ENCRYPTION_KEY || '';
  let key;
  try { key = Buffer.from(raw, 'base64'); } catch { key = Buffer.alloc(0); }
  if (key.length !== 32) throw new Error('DERIV_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}
export function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [b64url(iv), b64url(cipher.getAuthTag()), b64url(ciphertext)].join('.');
}
export function unseal(value) {
  const [iv, tag, ciphertext] = String(value || '').split('.');
  if (!iv || !tag || !ciphertext) throw new Error('INVALID_ENCRYPTED_VALUE');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), fromB64url(iv));
  decipher.setAuthTag(fromB64url(tag));
  return JSON.parse(Buffer.concat([decipher.update(fromB64url(ciphertext)), decipher.final()]).toString('utf8'));
}
export const clearOAuthCookie = COOKIE + '=; ' + COOKIE_OPTIONS + '; Max-Age=0';
export const setOAuthCookie = value => COOKIE + '=' + encodeURIComponent(seal(value)) + '; ' + COOKIE_OPTIONS + '; Max-Age=600';
export function readOAuthCookie(request) {
  const raw = request.headers.get('cookie') || '';
  const match = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!match) return null;
  try { return unseal(decodeURIComponent(match[1])); } catch { return null; }
}
function readDanteSession(request) {
  const raw = request.headers.get('cookie') || '';
  const match = raw.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  if (!match) return null;
  try {
    const value = JSON.parse(decodeURIComponent(match[1]));
    return value && typeof value.access_token === 'string' && typeof value.refresh_token === 'string' ? value : null;
  } catch { return null; }
}
export async function requireDanteUser(request) {
  const session = readDanteSession(request);
  const url = String(process.env.SUPABASE_URL || '').replace(/\\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY || '';
  if (!session || !url || !key) return null;
  const response = await fetch(url + '/auth/v1/user', {
    headers: { apikey: key, Authorization: 'Bearer ' + session.access_token },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user && typeof user.id === 'string' ? { id: user.id, email: user.email || '' } : null;
}
export function checkSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
export function randomBase64url(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
export function pkceChallenge(verifier) { return createHash('sha256').update(verifier).digest('base64url'); }
export function config() {
  const clientId = process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '';
  const redirectUri = process.env.DERIV_REDIRECT_URI || process.env.NEXT_PUBLIC_DERIV_REDIRECT_URI || '';
  const authBase = (process.env.DERIV_ENV || process.env.NEXT_PUBLIC_DERIV_ENV) === 'preview'
    ? 'https://staging-auth.deriv.com/oauth2' : 'https://auth.deriv.com/oauth2';
  const apiBase = (process.env.DERIV_ENV || process.env.NEXT_PUBLIC_DERIV_ENV) === 'preview'
    ? 'https://staging-api.derivws.com/trading/v1/options' : 'https://api.derivws.com/trading/v1/options';
  if (!clientId || !redirectUri) throw new Error('DERIV_APP_ID and DERIV_REDIRECT_URI must be configured');
  return { clientId, redirectUri, authBase, apiBase };
}
async function supabaseAdmin(path, options = {}) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_SERVER_CONFIGURATION_REQUIRED');
  return fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
}
export async function saveDerivToken(userId, token) {
  const encrypted = seal({ access_token: token.access_token, expires_at: token.expires_at, scope: token.scope });
  const response = await supabaseAdmin('deriv_token_vault?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, encrypted_token: encrypted, expires_at: new Date(token.expires_at * 1000).toISOString(), scope: token.scope }),
  });
  if (!response.ok) throw new Error('DERIV_TOKEN_VAULT_WRITE_FAILED');
}
export async function getDerivTokenStatus(userId) {
  const response = await supabaseAdmin('deriv_token_vault?user_id=eq.' + encodeURIComponent(userId) + '&select=expires_at&limit=1');
  if (!response.ok) throw new Error('DERIV_TOKEN_VAULT_READ_FAILED');
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows[0]) return { status: 'not_connected' };
  if (Date.parse(rows[0].expires_at) <= Date.now()) return { status: 'reauthorization_required' };
  return { status: 'connected' };
}
export async function getDerivToken(userId) {
  const response = await supabaseAdmin('deriv_token_vault?user_id=eq.' + encodeURIComponent(userId) + '&select=encrypted_token,expires_at&limit=1');
  if (!response.ok) throw new Error('DERIV_TOKEN_VAULT_READ_FAILED');
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows[0]) return null;
  const token = unseal(rows[0].encrypted_token);
  if (!token || typeof token.access_token !== 'string') return null;
  if (token.expires_at <= Math.floor(Date.now() / 1000)) throw new Error('DERIV_REAUTHORIZATION_REQUIRED');
  return token;
}
export async function saveSelectedAccount(userId, accountId) {
  const response = await supabaseAdmin('deriv_token_vault?user_id=eq.' + encodeURIComponent(userId), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ selected_account_id: accountId }),
  });
  if (!response.ok) throw new Error('DERIV_ACCOUNT_SELECTION_FAILED');
}
export async function getSelectedAccount(userId) {
  const response = await supabaseAdmin('deriv_token_vault?user_id=eq.' + encodeURIComponent(userId) + '&select=selected_account_id&limit=1');
  if (!response.ok) throw new Error('DERIV_ACCOUNT_SELECTION_FAILED');
  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0].selected_account_id : null;
}
export async function deleteDerivToken(userId) {
  const response = await supabaseAdmin('deriv_token_vault?user_id=eq.' + encodeURIComponent(userId), { method: 'DELETE' });
  if (!response.ok) throw new Error('DERIV_TOKEN_VAULT_DELETE_FAILED');
}
export { json };
