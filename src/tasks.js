// Google Tasks — tarefas DE VERDADE (as que aparecem na aba "Tarefas" do
// Calendar/app Google Tasks, com a caixinha de concluir que o Deivid marca).
//
// Por que OAuth e não conta de serviço: o Google não permite compartilhar
// listas de tarefas com uma conta de serviço (diferente da agenda). Então o bot
// age EM NOME do Deivid, usando um refresh_token que ele autorizou uma vez.

import { config } from './config.js';

const BASE = 'https://tasks.googleapis.com/tasks/v1';

let accessToken = null;
let expiraEm = 0; // epoch ms

function configurado() {
  const g = config.googleOauth;
  return Boolean(g.clientId && g.clientSecret && g.refreshToken);
}

// Troca o refresh_token por um access_token curto, com cache até expirar.
async function getToken() {
  if (!configurado()) {
    throw new Error('Google Tasks não configurado (faltam as variáveis GOOGLE_OAUTH_*)');
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

async function tasksFetch(path, method = 'GET', body) {
  const token = await getToken();
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Tasks ${res.status} ${t.slice(0, 250)}`);
  }
  return res.json().catch(() => ({}));
}

// Id da lista padrão ("Minhas tarefas"), em cache.
let listaPadrao = null;
async function getListaId() {
  if (config.googleOauth.taskListId) return config.googleOauth.taskListId;
  if (listaPadrao) return listaPadrao;
  const d = await tasksFetch('users/@me/lists');
  const primeira = (d.items || [])[0];
  if (!primeira) throw new Error('nenhuma lista de tarefas encontrada na conta');
  listaPadrao = primeira.id;
  return listaPadrao;
}

// Converte "YYYY-MM-DD" para o formato RFC3339 que o Tasks espera (data, sem hora útil).
function dueDe(quando) {
  if (!quando || !/^\d{4}-\d{2}-\d{2}$/.test(quando)) return undefined;
  return `${quando}T00:00:00.000Z`;
}

// Cria uma TAREFA real. quando = 'YYYY-MM-DD' (opcional = sem prazo).
export async function criarTarefa({ titulo, quando, descricao }) {
  const lista = await getListaId();
  const body = { title: titulo };
  if (descricao) body.notes = descricao;
  const due = dueDe(quando);
  if (due) body.due = due;
  const t = await tasksFetch(`lists/${lista}/tasks`, 'POST', body);
  return { id: t.id, titulo: t.title, link: t.webViewLink };
}

// Lista tarefas (por padrão só as pendentes).
export async function listarTarefas({ incluirConcluidas = false, max = 30 } = {}) {
  const lista = await getListaId();
  const params = new URLSearchParams({
    maxResults: String(max),
    showCompleted: String(incluirConcluidas),
  });
  if (incluirConcluidas) params.set('showHidden', 'true');
  const d = await tasksFetch(`lists/${lista}/tasks?${params.toString()}`);
  return (d.items || []).map((t) => ({
    id: t.id,
    titulo: t.title || '(sem título)',
    prazo: t.due ? String(t.due).slice(0, 10) : '',
    concluida: t.status === 'completed',
    notas: t.notes || '',
  }));
}

// Marca como CONCLUÍDA (é o mesmo check que o Deivid marca no celular).
export async function concluirTarefa({ id }) {
  if (!id) throw new Error('id da tarefa é obrigatório');
  const lista = await getListaId();
  await tasksFetch(`lists/${lista}/tasks/${encodeURIComponent(id)}`, 'PATCH', {
    status: 'completed',
  });
  return { ok: true };
}

// Reabre uma tarefa concluída.
export async function reabrirTarefa({ id }) {
  if (!id) throw new Error('id da tarefa é obrigatório');
  const lista = await getListaId();
  await tasksFetch(`lists/${lista}/tasks/${encodeURIComponent(id)}`, 'PATCH', {
    status: 'needsAction',
    completed: null,
  });
  return { ok: true };
}

// Edita título, prazo ou notas.
export async function editarTarefa({ id, titulo, quando, descricao }) {
  if (!id) throw new Error('id da tarefa é obrigatório');
  const lista = await getListaId();
  const body = {};
  if (titulo !== undefined) body.title = titulo;
  if (descricao !== undefined) body.notes = descricao;
  const due = dueDe(quando);
  if (due) body.due = due;
  await tasksFetch(`lists/${lista}/tasks/${encodeURIComponent(id)}`, 'PATCH', body);
  return { ok: true };
}

export async function apagarTarefa({ id }) {
  if (!id) throw new Error('id da tarefa é obrigatório');
  const lista = await getListaId();
  await tasksFetch(`lists/${lista}/tasks/${encodeURIComponent(id)}`, 'DELETE');
  return { ok: true };
}

export { configurado as tasksConfigurado };
