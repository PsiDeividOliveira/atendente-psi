// Integração com o Google Calendar (agenda do Deivid) via conta de serviço.
// O admin aciona por conversa; aqui a gente cria eventos e tarefas de verdade.

import { GoogleAuth } from 'google-auth-library';
import { config } from './config.js';

let client = null;

async function getToken() {
  if (!config.google.serviceAccountJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurada');
  }
  if (!client) {
    const creds = JSON.parse(config.google.serviceAccountJson);
    const auth = new GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    client = await auth.getClient();
  }
  const r = await client.getAccessToken();
  return typeof r === 'string' ? r : r.token;
}

const calId = () => encodeURIComponent(config.google.calendarId || 'primary');

async function calFetch(path, method = 'GET', body) {
  const token = await getToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Calendar ${res.status} ${t.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// Cria um COMPROMISSO com hora. inicio/fim = 'YYYY-MM-DDTHH:MM:SS' (horário de Brasília).
export async function criarEvento({ titulo, inicio, fim, descricao }) {
  const tz = config.google.timezone;
  const body = {
    summary: titulo,
    description: descricao || '',
    start: { dateTime: inicio, timeZone: tz },
    end: { dateTime: fim || inicio, timeZone: tz },
  };
  const ev = await calFetch(`calendars/${calId()}/events`, 'POST', body);
  return { id: ev.id, link: ev.htmlLink };
}

// Cria uma TAREFA como evento de dia inteiro. quando = 'YYYY-MM-DD' (ou vazio = hoje).
export async function criarTarefa({ titulo, quando, descricao }) {
  const dia = quando && /^\d{4}-\d{2}-\d{2}$/.test(quando) ? quando : hojeISO();
  const body = {
    summary: `✅ ${titulo}`,
    description: descricao || 'Tarefa criada pelo assistente.',
    start: { date: dia },
    end: { date: diaSeguinte(dia) }, // fim exclusivo no Google
  };
  const ev = await calFetch(`calendars/${calId()}/events`, 'POST', body);
  return { id: ev.id, link: ev.htmlLink };
}

// Lista os próximos compromissos/tarefas dos próximos N dias.
export async function listarProximos({ dias = 7 } = {}) {
  const agora = new Date();
  const ate = new Date(agora.getTime() + dias * 24 * 3600 * 1000);
  const params = new URLSearchParams({
    timeMin: agora.toISOString(),
    timeMax: ate.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20',
  });
  const data = await calFetch(`calendars/${calId()}/events?${params.toString()}`);
  return (data.items || []).map((e) => ({
    titulo: e.summary || '(sem título)',
    inicio: e.start?.dateTime || e.start?.date || '',
    link: e.htmlLink,
  }));
}

// ── helpers de data ──────────────────────────────────────────
function hojeISO() {
  // Data de hoje no fuso configurado, em 'YYYY-MM-DD'.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.google.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA => YYYY-MM-DD
}

function diaSeguinte(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
