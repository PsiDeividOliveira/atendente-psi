// Camada de dados — Postgres é a fonte da verdade.
// Cria as tabelas no boot, faz o seed inicial dos produtos e expõe os helpers
// que o atendente e o admin usam. Leitura da base tem cache curto invalidado a cada escrita.

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, '..', 'data', 'catalog.seed.json');

let pool = null;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.db.url, max: 5 });
    pool.on('error', (e) => console.error('[db] pool error:', e.message));
  }
  return pool;
}
const q = (text, params) => getPool().query(text, params);

const SCHEMA = `
create table if not exists produtos (
  id text primary key,
  nome text not null,
  tipo text,
  resumo text,
  para_quem text,
  detalhes text,
  preco_avista text,
  preco_parcelado text,
  garantia text,
  link text,
  ativo boolean default true,
  atualizado_em timestamptz default now()
);
create table if not exists config (
  chave text primary key,
  valor text,
  atualizado_em timestamptz default now()
);
create table if not exists faq (
  id serial primary key,
  pergunta text not null,
  resposta text not null,
  origem text default 'manual',
  criado_em timestamptz default now()
);
create table if not exists leads (
  id serial primary key,
  nome text,
  contato text,
  interesse text,
  detalhes text,
  origem text default 'whatsapp',
  status text default 'novo',
  criado_em timestamptz default now()
);
create table if not exists pendencias (
  id serial primary key,
  cliente_numero text not null,
  cliente_nome text,
  pergunta text not null,
  contexto text,
  notify_msg_id text,
  status text default 'aberta',
  resposta text,
  criado_em timestamptz default now(),
  respondido_em timestamptz
);
create table if not exists auditoria (
  id serial primary key,
  acao text,
  detalhe text,
  autor text,
  criado_em timestamptz default now()
);
create table if not exists historico (
  id serial primary key,
  contato text not null,
  role text not null,
  content text not null,
  criado_em timestamptz default now()
);
create index if not exists idx_historico_contato on historico (contato, id);
create table if not exists pausas (
  contato text primary key,
  ate timestamptz not null,
  motivo text,
  criado_em timestamptz default now()
);
`;

export async function initDb() {
  await q(SCHEMA);
  await seedIfEmpty();
  console.log('[db] schema pronto');
}

async function seedIfEmpty() {
  const { rows } = await q('select count(*)::int as n from produtos');
  if (rows[0].n > 0) return;
  const seed = JSON.parse(await readFile(SEED_PATH, 'utf8'));
  for (const p of seed.produtos || []) {
    await upsertProduto(p, 'seed');
  }
  for (const [chave, valor] of Object.entries(seed.config || {})) {
    await setConfig(chave, String(valor), 'seed');
  }
  for (const f of seed.faq || []) {
    await addFaq(f.pergunta, f.resposta, 'manual');
  }
  console.log('[db] seed inicial carregado a partir de catalog.seed.json');
}

// ── Cache da base ────────────────────────────────────────────
let cache = { at: 0, data: null };
export function bumpCache() {
  cache = { at: 0, data: null };
}

export async function loadBase() {
  const now = Date.now() / 1000;
  if (cache.data && now - cache.at < config.cacheTtl) return cache.data;

  const [prod, cfg, faqRows] = await Promise.all([
    q('select * from produtos where ativo = true order by atualizado_em desc'),
    q('select chave, valor from config'),
    q('select pergunta, resposta from faq order by criado_em desc limit 100'),
  ]);

  const data = {
    produtos: prod.rows,
    config: Object.fromEntries(cfg.rows.map((r) => [r.chave, r.valor])),
    faq: faqRows.rows,
  };
  cache = { at: now, data };
  return data;
}

// ── Escritas (invalidam cache) ───────────────────────────────
export async function upsertProduto(p, autor = 'admin') {
  await q(
    `insert into produtos (id, nome, tipo, resumo, para_quem, detalhes, preco_avista, preco_parcelado, garantia, link, ativo, atualizado_em)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (id) do update set
       nome=excluded.nome, tipo=excluded.tipo, resumo=excluded.resumo, para_quem=excluded.para_quem,
       detalhes=excluded.detalhes, preco_avista=excluded.preco_avista, preco_parcelado=excluded.preco_parcelado,
       garantia=excluded.garantia, link=excluded.link, ativo=excluded.ativo, atualizado_em=now()`,
    [p.id, p.nome, p.tipo || '', p.resumo || '', p.para_quem || '', p.detalhes || '',
     p.preco_avista || '', p.preco_parcelado || '', p.garantia || '', p.link || '',
     p.ativo === false ? false : true],
  );
  await addAudit('upsert_produto', `${p.id}: ${p.nome}`, autor);
  bumpCache();
}

// Atualiza UM campo de um produto localizado por id OU nome (parcial, case-insensitive).
export async function updateProdutoCampo(idOuNome, campo, valor, autor = 'admin') {
  const permitidos = ['nome', 'tipo', 'resumo', 'para_quem', 'detalhes', 'preco_avista',
    'preco_parcelado', 'garantia', 'link', 'ativo'];
  if (!permitidos.includes(campo)) throw new Error(`campo inválido: ${campo}`);
  const val = campo === 'ativo' ? /^(sim|true|1|ativo)$/i.test(String(valor)) : valor;
  const { rows } = await q(
    `update produtos set ${campo} = $1, atualizado_em = now()
     where id = $2 or nome ilike '%'||$2||'%' returning id, nome`,
    [val, idOuNome],
  );
  if (rows.length === 0) throw new Error(`produto não encontrado: ${idOuNome}`);
  await addAudit('update_produto', `${rows.map((r) => r.id).join(',')} ${campo}=${valor}`, autor);
  bumpCache();
  return rows;
}

export async function setConfig(chave, valor, autor = 'admin') {
  await q(
    `insert into config (chave, valor, atualizado_em) values ($1,$2, now())
     on conflict (chave) do update set valor=excluded.valor, atualizado_em=now()`,
    [chave, valor],
  );
  await addAudit('set_config', `${chave}=${valor}`, autor);
  bumpCache();
}

export async function addFaq(pergunta, resposta, origem = 'manual', autor = 'admin') {
  const { rows } = await q(
    'insert into faq (pergunta, resposta, origem) values ($1,$2,$3) returning id',
    [pergunta, resposta, origem],
  );
  await addAudit('add_faq', `${origem}: ${pergunta}`, autor);
  bumpCache();
  return rows[0].id;
}

export async function removeFaq(id, autor = 'admin') {
  await q('delete from faq where id = $1', [id]);
  await addAudit('remove_faq', `#${id}`, autor);
  bumpCache();
}

export async function appendLead(lead) {
  const { rows } = await q(
    `insert into leads (nome, contato, interesse, detalhes, origem, status)
     values ($1,$2,$3,$4,$5,'novo') returning id`,
    [lead.nome || '', lead.contato || '', lead.interesse || 'outro',
     lead.detalhes || '', lead.origem || 'whatsapp'],
  );
  return { ok: true, id: rows[0].id };
}

export async function listLeads({ interesse, limite = 20 } = {}) {
  const params = [];
  let where = '';
  if (interesse) { params.push(interesse); where = 'where interesse = $1'; }
  params.push(limite);
  const { rows } = await q(
    `select id, nome, contato, interesse, detalhes, status, criado_em
     from leads ${where} order by criado_em desc limit $${params.length}`,
    params,
  );
  return rows;
}

// ── Pendências (escalação) ───────────────────────────────────
export async function createPendencia({ cliente_numero, cliente_nome, pergunta, contexto }) {
  const { rows } = await q(
    `insert into pendencias (cliente_numero, cliente_nome, pergunta, contexto)
     values ($1,$2,$3,$4) returning id`,
    [cliente_numero, cliente_nome || '', pergunta, contexto || ''],
  );
  return rows[0].id;
}

export async function setPendenciaNotifyMsg(id, msgId) {
  await q('update pendencias set notify_msg_id = $1 where id = $2', [msgId, id]);
}

export async function getPendenciaByMsgId(msgId) {
  const { rows } = await q(
    "select * from pendencias where notify_msg_id = $1 and status = 'aberta' limit 1",
    [msgId],
  );
  return rows[0] || null;
}

export async function getOpenPendencias() {
  const { rows } = await q("select * from pendencias where status = 'aberta' order by criado_em");
  return rows;
}

export async function getPendenciaById(id) {
  const { rows } = await q('select * from pendencias where id = $1 limit 1', [id]);
  return rows[0] || null;
}

export async function resolvePendencia(id, resposta) {
  await q(
    "update pendencias set status='respondida', resposta=$1, respondido_em=now() where id=$2",
    [resposta, id],
  );
}

export async function expirePendencia(id) {
  await q("update pendencias set status='expirada', respondido_em=now() where id=$1", [id]);
}

export async function getPendenciasVencidas(minutos) {
  const { rows } = await q(
    `select * from pendencias where status='aberta'
       and criado_em < now() - ($1 || ' minutes')::interval`,
    [String(minutos)],
  );
  return rows;
}

export async function addAudit(acao, detalhe, autor = 'sistema') {
  try {
    await q('insert into auditoria (acao, detalhe, autor) values ($1,$2,$3)', [acao, detalhe, autor]);
  } catch (e) {
    console.warn('[db] auditoria falhou:', e.message);
  }
}

// ── Histórico de conversa (persistente, por contato) ─────────
export async function appendHistorico(contato, role, content) {
  await q('insert into historico (contato, role, content) values ($1,$2,$3)', [contato, role, String(content)]);
}

// Últimas N mensagens do contato, em ordem cronológica.
export async function getHistorico(contato, limite = 20) {
  const { rows } = await q(
    'select role, content from historico where contato = $1 order by id desc limit $2',
    [contato, limite],
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

export async function limparHistorico(contato) {
  await q('delete from historico where contato = $1', [contato]);
}

// ── Pausa de atendimento (handoff: o Deivid assumiu a conversa) ─
// Enquanto pausado, o bot não responde aquele contato. Renova a cada ação humana.
export async function pausarContato(contato, minutos, motivo = 'humano assumiu') {
  await q(
    `insert into pausas (contato, ate, motivo, criado_em)
     values ($1, now() + ($2 || ' minutes')::interval, $3, now())
     on conflict (contato) do update set ate=excluded.ate, motivo=excluded.motivo, criado_em=now()`,
    [contato, String(minutos), motivo],
  );
}

export async function retomarContato(contato) {
  await q('delete from pausas where contato = $1', [contato]);
}

// true se o contato está pausado agora (ate ainda no futuro).
export async function contatoPausado(contato) {
  const { rows } = await q('select 1 from pausas where contato = $1 and ate > now() limit 1', [contato]);
  return rows.length > 0;
}

export async function listarPausas() {
  const { rows } = await q(
    'select contato, ate, motivo from pausas where ate > now() and contato <> $1 order by ate desc',
    [GLOBAL_KEY],
  );
  return rows;
}

// ── Silêncio GLOBAL (o bot inteiro fica inoperante) ──────────
// Usa a mesma tabela de pausas, com uma chave reservada. O admin nunca é bloqueado.
export const GLOBAL_KEY = '__GLOBAL__';

// Silencia por X minutos a partir de agora.
export async function silenciarPorMinutos(minutos, motivo = 'silenciado pelo Deivid') {
  await pausarContato(GLOBAL_KEY, minutos, motivo);
}

// Silencia até uma data/hora ABSOLUTA, interpretada no fuso de Brasília.
// quandoISO = 'YYYY-MM-DDTHH:MM:SS'
export async function silenciarAte(quandoISO, motivo = 'silenciado pelo Deivid') {
  await q(
    `insert into pausas (contato, ate, motivo, criado_em)
     values ($1, ($2::timestamp at time zone 'America/Sao_Paulo'), $3, now())
     on conflict (contato) do update set ate=excluded.ate, motivo=excluded.motivo, criado_em=now()`,
    [GLOBAL_KEY, quandoISO, motivo],
  );
}

export async function reativarBot() {
  await retomarContato(GLOBAL_KEY);
}

export async function botSilenciado() {
  return contatoPausado(GLOBAL_KEY);
}

// Retorna { ate, motivo } se estiver silenciado, senão null.
export async function statusSilencio() {
  const { rows } = await q(
    'select ate, motivo from pausas where contato = $1 and ate > now() limit 1',
    [GLOBAL_KEY],
  );
  return rows[0] || null;
}
