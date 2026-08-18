// Token OAuth do Deivid (age EM NOME dele). Usado pra Google Tasks e pra criar
// eventos com Google Meet (a conta de serviço não gera Meet válido).
// O refresh_token foi autorizado uma vez e cobre os escopos tasks + calendar.events.

import { config } from './config.js';

let accessToken = null;
let expiraEm = 0; // epoch ms

export function oauthConfigurado() {
  const g = config.googleOauth;
  return Boolean(g.clientId && g.clientSecret && g.refreshToken);
}

// Troca o refresh_token por um access_token curto, com cache até quase expirar.
export async function getOAuthToken() {
  if (!oauthConfigurado()) {
    throw new Error('OAuth do Google não configurado (faltam GOOGLE_OAUTH_*)');
  }
  if (accessToken && Date.now() < expiraEm - 60_000) return accessToken;

  const g = config.googleOauth;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: g.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OAuth ${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  accessToken = j.access_token;
  expiraEm = Date.now() + (Number(j.expires_in || 3600) * 1000);
  return accessToken;
}
