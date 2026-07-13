// Servidor do atendente: recebe o webhook da Evolution e roteia entre
// cliente, agente-admin e resolução de escalação. Sobe o banco no boot.

import express from 'express';
import { config } from './config.js';
import { initDb } from './db.js';
import { handleCustomer, setLeadNotifier } from './agent.js';
import { handleAdmin } from './adminAgent.js';
import { resolverPorCitacao, varrerTimeouts } from './escalation.js';
import { sendText, sendTyping } from './evolution.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.send('atendente-psi ok'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Extrai número, texto, pushName e id da mensagem citada (pra escalação).
function parseEvent(body) {
  const data = body?.data;
  if (!data) return null;
  const key = data.key || {};
  if (key.fromMe) return null;
  const jid = key.remoteJid || '';
  if (jid.endsWith('@g.us')) return null; // ignora grupos
  const number = (jid.split('@')[0] || '').replace(/\D/g, '');
  if (!number) return null;

  const msg = data.message || {};
  const ext = msg.extendedTextMessage;
  const text = msg.conversation || ext?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
  const quotedMsgId = ext?.contextInfo?.stanzaId || null; // id da mensagem que ele respondeu/citou

  return { number, text: String(text).trim(), pushName: data.pushName || '', quotedMsgId };
}

// Notifica o Deivid quando chega lead que precisa de ação dele.
setLeadNotifier(async (lead) => {
  if (!config.notifyNumber) return;
  if (!['clinica', 'palestra', 'URGENTE-CRISE'].includes(lead.interesse)) return;
  const flag = lead.interesse === 'URGENTE-CRISE' ? '🚨 URGENTE (CRISE)' : '🔔 Novo lead';
  const txt =
    `${flag}\nInteresse: ${lead.interesse}\nNome: ${lead.nome || '—'}\n` +
    `Contato: ${lead.contato || '—'}\nDetalhes: ${lead.detalhes || '—'}`;
  await sendText(config.notifyNumber, txt).catch((e) => console.error('[notify]', e.message));
});

app.post('/webhook', async (req, res) => {
  if (config.webhookToken) {
    const got = req.get('x-webhook-token') || req.query.token;
    if (got !== config.webhookToken) return res.status(401).send('unauthorized');
  }
  res.status(200).json({ received: true }); // responde rápido; processa em background

  try {
    const evt = parseEvent(req.body);
    if (!evt || !evt.text) return;

    const ehAdmin = config.admin.number && evt.number === config.admin.number;

    if (ehAdmin) {
      // 1) É uma resposta CITANDO uma notificação de dúvida? Resolve a escalação.
      if (evt.quotedMsgId) {
        const resolvido = await resolverPorCitacao(evt.quotedMsgId, evt.text);
        if (resolvido) return;
      }
      // 2) Senão, é comando de administração.
      const reply = await handleAdmin(evt.number, evt.text);
      await sendText(evt.number, reply);
      return;
    }

    // Cliente comum
    await sendTyping(evt.number, 1200);
    const reply = await handleCustomer(evt.number, evt.text, evt.pushName);
    await sendText(evt.number, reply);
  } catch (err) {
    console.error('[webhook] erro:', err);
  }
});

async function boot() {
  if (config.db.url) {
    try {
      await initDb();
    } catch (e) {
      console.error('[boot] falha ao iniciar o banco:', e.message);
    }
  } else {
    console.warn('[boot] DATABASE_URL não definida — o serviço sobe, mas sem banco não funciona de verdade.');
  }

  // Sweeper de timeouts das escalações (a cada 2 min)
  setInterval(() => {
    varrerTimeouts().catch((e) => console.error('[sweeper]', e.message));
  }, 120_000);

  app.listen(config.port, () => {
    console.log(`atendente-psi ouvindo na porta ${config.port}`);
    console.log(`modelo: ${config.claude.model} | evolution: ${config.evolution.url}`);
    console.log(`admin: ${config.admin.number || '(não definido)'} | timeout escalação: ${config.escalationTimeoutMin}min`);
  });
}

boot();
