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

// Cores de evento do Google Calendar (colorId oficial). Aceita nomes em PT.
const CORES = {
  vermelho: '11', tomate: '11',
  laranja: '6', tangerina: '6',
  amarelo: '5', banana: '5',
  verde: '10', 'verde-escuro': '10', manjericao: '10',
  'verde-claro': '2', sage: '2',
  azul: '9', 'azul-escuro': '9', 'azul-marinho': '9',
  'azul-claro': '7', pavao: '7', ciano: '7', turquesa: '7',
  roxo: '3', uva: '3',
  lavanda: '1', 'roxo-claro': '1',
  rosa: '4', salmao: '4', flamingo: '4',
  cinza: '8', grafite: '8',
};
function corId(cor) {
  if (!cor) return undefined;
  return CORES[String(cor).toLowerCase().trim()];
}

// Monta a regra de recorrência (RRULE) do Google a partir de termos em PT.
function buildRRULE({ recorrencia, repeticoes, ate }) {
  if (!recorrencia) return undefined;
  const FREQ = {
    diaria: 'FREQ=DAILY', diario: 'FREQ=DAILY',
    semanal: 'FREQ=WEEKLY', semanalmente: 'FREQ=WEEKLY',
    quinzenal: 'FREQ=WEEKLY;INTERVAL=2',
    mensal: 'FREQ=MONTHLY', mensalmente: 'FREQ=MONTHLY',
    anual: 'FREQ=YEARLY', anualmente: 'FREQ=YEARLY',
  };
  let rule = FREQ[String(recorrencia).toLowerCase().trim()];
  if (!rule) return undefined;
  if (repeticoes && Number(repeticoes) > 0) {
    rule += `;COUNT=${Math.floor(Number(repeticoes))}`;
  } else if (ate && /^\d{4}-\d{2}-\d{2}$/.test(ate)) {
    rule += `;UNTIL=${ate.replace(/-/g, '')}T235959Z`;
  }
  return [`RRULE:${rule}`];
}

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
export async function criarEvento({ titulo, inicio, fim, descricao, cor, recorrencia, repeticoes, ate }) {
  const tz = config.google.timezone;
  const body = {
    summary: titulo,
    description: descricao || '',
    start: { dateTime: inicio, timeZone: tz },
    end: { dateTime: fim || inicio, timeZone: tz },
  };
  const cid = corId(cor);
  if (cid) body.colorId = cid;
  const rec = buildRRULE({ recorrencia, repeticoes, ate });
  if (rec) body.recurrence = rec;
  const ev = await calFetch(`calendars/${calId()}/events`, 'POST', body);
  return { id: ev.id, link: ev.htmlLink };
}

// Cria uma TAREFA como evento de dia inteiro. quando = 'YYYY-MM-DD' (ou vazio = hoje).
export async function criarTarefa({ titulo, quando, descricao, cor }) {
  const dia = quando && /^\d{4}-\d{2}-\d{2}$/.test(quando) ? quando : hojeISO();
  const body = {
    summary: `✅ ${titulo}`,
    description: descricao || 'Tarefa criada pelo assistente.',
    start: { date: dia },
    end: { date: diaSeguinte(dia) }, // fim exclusivo no Google
  };
  const cid = corId(cor);
  if (cid) body.colorId = cid;
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
    id: e.id,
    titulo: e.summary || '(sem título)',
    inicio: e.start?.dateTime || e.start?.date || '',
    link: e.htmlLink,
  }));
}

// Edita um evento existente (PATCH — só os campos enviados são alterados).
export async function atualizarEvento({ id, titulo, inicio, fim, descricao, cor }) {
  if (!id) throw new Error('id do evento é obrigatório');
  const tz = config.google.timezone;
  const body = {};
  if (titulo !== undefined) body.summary = titulo;
  if (descricao !== undefined) body.description = descricao;
  if (inicio) body.start = { dateTime: inicio, timeZone: tz };
  if (fim) body.end = { dateTime: fim, timeZone: tz };
  const cid = corId(cor);
  if (cid) body.colorId = cid;
  const ev = await calFetch(`calendars/${calId()}/events/${encodeURIComponent(id)}`, 'PATCH', body);
  return { id: ev.id, link: ev.htmlLink };
}

// Apaga (remove de vez) um evento pelo id.
export async function apagarEvento({ id }) {
  if (!id) throw new Error('id do evento é obrigatório');
  await calFetch(`calendars/${calId()}/events/${encodeURIComponent(id)}`, 'DELETE');
  return { ok: true };
}

async function getEvento(id) {
  return calFetch(`calendars/${calId()}/events/${encodeURIComponent(id)}`);
}

// Remove marcadores de status antigos do título pra não empilhar (✔️/❌).
function tituloLimpo(summary) {
  return (summary || '').replace(/^\s*(✔️|✅|❌\s*CANCELADO\s*—|❌)\s*/u, '').trim();
}

// Marca um evento como CONCLUÍDO (✔️ no título + verde), mantendo na agenda.
export async function concluirEvento({ id }) {
  if (!id) throw new Error('id do evento é obrigatório');
  const ev = await getEvento(id);
  const body = { summary: `✔️ ${tituloLimpo(ev.summary)}`, colorId: CORES.verde };
  await calFetch(`calendars/${calId()}/events/${encodeURIComponent(id)}`, 'PATCH', body);
  return { ok: true };
}

// Marca um evento como CANCELADO (❌ no título + cinza), SEM apagar (fica de registro).
export async function cancelarEvento({ id }) {
  if (!id) throw new Error('id do evento é obrigatório');
  const ev = await getEvento(id);
  const body = { summary: `❌ CANCELADO — ${tituloLimpo(ev.summary)}`, colorId: CORES.cinza };
  await calFetch(`calendars/${calId()}/events/${encodeURIComponent(id)}`, 'PATCH', body);
  return { ok: true };
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
