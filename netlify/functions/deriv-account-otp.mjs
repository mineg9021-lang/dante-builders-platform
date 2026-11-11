import { config, getDerivToken, getSelectedAccount, json, requireDanteUser, saveSelectedAccount } from './_shared/deriv-oauth.mjs';

export default async request => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!request.headers.get('content-type')?.includes('application/json')) return json({ error: 'INVALID_CONTENT_TYPE' }, 415);
  const user = await requireDanteUser(request);
  if (!user) return json({ error: 'DANTE_LOGIN_REQUIRED' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  if (!/^[A-Za-z0-9]{3,32}$/.test(accountId)) return json({ error: 'INVALID_ACCOUNT_ID' }, 400);
  try {
    const token = await getDerivToken(user.id);
    if (!token) return json({ error: 'DERIV_REAUTHORIZATION_REQUIRED', reauthorizationRequired: true }, 401);
    const cfg = config();
    const accountsResponse = await fetch(cfg.apiBase + '/accounts', { headers: { Authorization: 'Bearer ' + token.access_token, 'Deriv-App-ID': cfg.clientId } });
    if (accountsResponse.status === 401) return json({ error: 'DERIV_REAUTHORIZATION_REQUIRED', reauthorizationRequired: true }, 401);
    if (!accountsResponse.ok) return json({ error: 'DERIV_ACCOUNTS_UNAVAILABLE' }, 502);
    const accounts = (await accountsResponse.json())?.data;
    const account = Array.isArray(accounts) ? accounts.find(item => item.account_id === accountId) : null;
    if (!account || !['demo', 'real'].includes(account.account_type)) return json({ error: 'SELECTED_DERIV_ACCOUNT_NOT_AVAILABLE' }, 403);
    const selected = await getSelectedAccount(user.id);
    if (selected !== accountId) await saveSelectedAccount(user.id, accountId);
    const response = await fetch(cfg.apiBase + '/accounts/' + encodeURIComponent(accountId) + '/otp', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token.access_token, 'Deriv-App-ID': cfg.clientId },
    });
    if (response.status === 401) return json({ error: 'DERIV_REAUTHORIZATION_REQUIRED', reauthorizationRequired: true }, 401);
    if (!response.ok) return json({ error: 'DERIV_WEBSOCKET_OTP_UNAVAILABLE' }, 502);
    const payload = await response.json();
    if (typeof payload?.data?.url !== 'string' || !payload.data.url.startsWith('wss://')) return json({ error: 'DERIV_WEBSOCKET_URL_INVALID' }, 502);
    return json({ url: payload.data.url, account: { account_id: account.account_id, account_type: account.account_type } });
  } catch (error) {
    if (error?.message === 'DERIV_REAUTHORIZATION_REQUIRED') return json({ error: 'DERIV_REAUTHORIZATION_REQUIRED', reauthorizationRequired: true }, 401);
    return json({ error: 'DERIV_WEBSOCKET_SERVICE_UNAVAILABLE' }, 503);
  }
};
