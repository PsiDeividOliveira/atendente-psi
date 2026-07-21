// Servidor do atendente: recebe o webhook da Evolution e roteia entre
// cliente, agente-admin e resolução de escalação. Sobe o banco no boot.

import express from 'express';
import { config } from './config.js';
import { initDb, pausarContato, contatoPausado, botSilenciado } from './db.js';
import { handleCustomer, setLeadNotifier } from './agent.js';
import { handleAdmin } from './adminAgent.js';
import { resolverPorCitacao, varrerTimeouts } from './escalation.js';
import { sendText, sendTyping, getMediaBase64, foiEnviadoPeloBot } from './evolution.js';
import { transcribeAudio } from './transcribe.js';
import { pushMessage } from './memory.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.send('atendente-psi ok'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Extrai número, texto, pushName e id da mensagem citada (pra escalação).
function parseEvent(body) {
  const data = body?.data;
  if (!data) return null;
  const key = data.key || {};
  const jid = key.remoteJid || '';
  if (jid.endsWith('@g.us')) return null; // ignora grupos
  const number = (jid.split('@')[0] || '').replace(/\D/g, '');
  if (!number) return null;

  const msg = data.message || {};
  const ext = msg.extendedTextMessage;
  const text = msg.conversation || ext?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
  const quotedMsgId = ext?.contextInfo?.stanzaId || null; // id da mensagem que ele respondeu/citou

  // Áudio (nota de voz = audioMessage, geralmente ptt:true) — vamos transcrever.
  const audio = msg.audioMessage
    ? { mimetype: msg.audioMessage.mimetype || 'audio/ogg' }
    : null;

  // Imagem ou documento (PDF) — o Claude vê/lê nativamente.
  const docMsg = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage || null;
  let media = null;
  if (msg.imageMessage) media = { kind: 'image', mimetype: msg.imageMessage.mimetype || 'image/jpeg' };
  else if (docMsg) media = { kind: 'document', mimetype: docMsg.mimetype || '' };

  return {
    number,
    text: String(text).trim(),
    pushName: data.pushName || '',
    quotedMsgId,
    audio,
    media,
    key: data.key || null,
    fromMe: Boolean(key.fromMe),
    msgId: key.id || null,
  };
}

// Descobre o formato do áudio a partir do mimetype (pra mandar pro transcritor).
function formatoAudio(mimetype = '') {
  const m = mimetype.toLowerCase();
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'ogg';
}

// Normaliza número BR p/ comparação: o WhatsApp às vezes reporta celulares
// sem o 9º dígito (55 + DDD + 8) e às vezes com ele (55 + DDD + 9 + 8).
// Removemos o "9" extra pra as duas formas baterem.
function normBR(num) {
  const d = String(num || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') return d.slice(0, 4) + d.slice(5);
  return d;
}
const mesmoNumero = (a, b) => Boolean(a) && Boolean(b) && normBR(a) === normBR(b);

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
    if (!evt) return;

    // Mensagem que SAIU do WhatsApp do bot (fromMe): ou é o próprio bot (eco da
    // resposta), ou é o Deivid respondendo um cliente manualmente (assumiu a conversa).
    if (evt.fromMe) {
      if (foiEnviadoPeloBot(evt.msgId)) return; // eco do próprio bot → ignora
      if (mesmoNumero(evt.number, config.admin.number)) return; // conversa do próprio admin
      try {
        await pausarContato(normBR(evt.number), config.humanTakeoverPauseMin, 'Deivid assumiu');
        console.log(`[handoff] Deivid assumiu ${evt.number} — bot em silêncio por ${config.humanTakeoverPauseMin}min`);
      } catch (e) {
        console.error('[handoff]', e.message);
      }
      return;
    }

    // Áudio (nota de voz) → transcreve pra texto antes de rotear.
    if (!evt.text && evt.audio && evt.key) {
      try {
        await sendTyping(evt.number, 1500);
        const { base64, mimetype } = await getMediaBase64(evt.key);
        if (base64) {
          evt.text = await transcribeAudio(base64, formatoAudio(mimetype || evt.audio.mimetype));
          console.log(`[audio] transcrito (${evt.text.length} chars) de ${evt.number}`);
        }
      } catch (e) {
        console.error('[audio] falha na transcrição:', e.message);
        await sendText(
          evt.number,
          'Recebi seu áudio, mas tive um probleminha pra ouvir agora. Pode me mandar por texto que eu te ajudo? 😊',
        ).catch(() => {});
        return;
      }
    }

    // Imagem / documento (PDF) → baixa e anexa pro Claude ver/ler.
    let attachment = null;
    if (evt.media && evt.key) {
      try {
        const { base64, mimetype } = await getMediaBase64(evt.key);
        const mt = (mimetype || evt.media.mimetype || '').split(';')[0].trim();
        if (evt.media.kind === 'image' && base64) {
          attachment = { kind: 'image', media_type: mt || 'image/jpeg', data: base64 };
        } else if (evt.media.kind === 'document' && /pdf/i.test(mt) && base64) {
          attachment = { kind: 'document', media_type: 'application/pdf', data: base64 };
        } else if (evt.media.kind === 'document') {
          await sendText(
            evt.number,
            'Recebi seu documento, mas por enquanto só consigo ler PDF. Pode me mandar em PDF ou me contar o que é? 😊',
          ).catch(() => {});
          return;
        }
      } catch (e) {
        console.error('[media] falha ao baixar/anexar:', e.message);
      }
    }

    if (!evt.text && !attachment) return; // nada útil → ignora silenciosamente

    const ehAdmin = mesmoNumero(evt.number, config.admin.number);

    if (ehAdmin) {
      // 1) É uma resposta CITANDO uma notificação de dúvida? Resolve a escalação.
      if (evt.quotedMsgId && evt.text) {
        const resolvido = await resolverPorCitacao(evt.quotedMsgId, evt.text);
        if (resolvido) return;
      }
      // 2) Senão, é comando de administração.
      const reply = await handleAdmin(evt.number, evt.text, attachment);
      await sendText(evt.number, reply);
      return;
    }

    // Bot silenciado por completo (modo inoperante que o Deivid ativou)?
    // O admin nunca cai aqui — ele já foi tratado acima e sempre consegue reativar.
    if (await botSilenciado()) {
      try { if (evt.text) await pushMessage(evt.number, { role: 'user', content: evt.text }); } catch {}
      console.log(`[silencio] bot inoperante — não respondi ${evt.number}.`);
      return;
    }

    // Cliente comum — mas se o Deivid assumiu essa conversa, o bot fica em silêncio.
    if (await contatoPausado(normBR(evt.number))) {
      // Guarda a mensagem no histórico (pra manter contexto se o bot voltar), sem responder.
      try { if (evt.text) await pushMessage(evt.number, { role: 'user', content: evt.text }); } catch {}
      console.log(`[handoff] ${evt.number} está com o Deivid — bot não respondeu.`);
      return;
    }
    await sendTyping(evt.number, 1200);
    const reply = await handleCustomer(evt.number, evt.text, evt.pushName, attachment);
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
