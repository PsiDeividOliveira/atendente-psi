// Escalação human-in-the-loop.
// Quando o atendente não sabe, cria uma pendência, avisa o Deivid e SEGURA o cliente.
// Quando o Deivid responde (citando a mensagem), repassa ao cliente e aprende (salva na FAQ).

import { config } from './config.js';
import { sendText } from './evolution.js';
import { pushMessage } from './memory.js';
import * as db from './db.js';
import { appendLead } from './db.js';

// Cria a pendência e notifica o Deivid. Retorna o id da pendência.
export async function abrirPendencia({ clienteNumero, clienteNome, pergunta, contexto }) {
  const id = await db.createPendencia({
    cliente_numero: clienteNumero,
    cliente_nome: clienteNome,
    pergunta,
    contexto,
  });

  if (config.notifyNumber) {
    const nome = clienteNome ? `${clienteNome} (${clienteNumero})` : clienteNumero;
    const texto =
      `🙋 *Dúvida que eu não sei responder* — pendência #${id}\n\n` +
      `De: ${nome}\n` +
      `Pergunta: "${pergunta}"\n\n` +
      `➡️ *Responda ESTA mensagem (citando/respondendo)* com a resposta certa, que eu repasso pra pessoa e guardo pra próxima.`;
    try {
      const res = await sendText(config.notifyNumber, texto);
      const msgId = res?.key?.id || res?.message?.key?.id;
      if (msgId) await db.setPendenciaNotifyMsg(id, msgId);
    } catch (e) {
      console.error('[escalation] falha ao notificar Deivid:', e.message);
    }
  }
  return id;
}

// Resolve uma pendência com a resposta do Deivid: repassa ao cliente e aprende.
async function concluir(pendencia, resposta) {
  await db.resolvePendencia(pendencia.id, resposta);

  // Repassa a resposta pro cliente (com um enquadramento acolhedor)
  const msg = `Consegui confirmar aqui! 😊\n\n${resposta}`;
  await sendText(pendencia.cliente_numero, msg);
  await pushMessage(pendencia.cliente_numero, { role: 'assistant', content: msg });

  // Aprende: salva Pergunta+Resposta na FAQ (origem "aprendida"). Auto-save com undo.
  try {
    await db.addFaq(pendencia.pergunta, resposta, 'aprendida', 'deivid');
  } catch (e) {
    console.warn('[escalation] não consegui salvar na FAQ:', e.message);
  }

  // Confirma pro Deivid
  if (config.notifyNumber) {
    await sendText(
      config.notifyNumber,
      `✅ Repassei pra pessoa e guardei no banco pra próxima (pendência #${pendencia.id}).\n` +
        `Se preferir não guardar, me diga: "apaga a última FAQ aprendida".`,
    ).catch(() => {});
  }
  return true;
}

// Tenta resolver a partir de uma resposta do Deivid que CITOU a mensagem de notificação.
export async function resolverPorCitacao(quotedMsgId, resposta) {
  if (!quotedMsgId) return false;
  const pend = await db.getPendenciaByMsgId(quotedMsgId);
  if (!pend) return false;
  await concluir(pend, resposta);
  return true;
}

// Resolve uma pendência pelo id (usado pelo agente-admin: "responde a pendência #3 ...").
export async function resolverPorId(id, resposta) {
  const pend = await db.getPendenciaById(id);
  if (!pend) return { ok: false, motivo: 'pendência não encontrada' };
  if (pend.status !== 'aberta') return { ok: false, motivo: `pendência #${id} já está ${pend.status}` };
  await concluir(pend, resposta);
  return { ok: true };
}

// Fallback: se o Deivid respondeu sem citar e só existe UMA pendência aberta, resolve essa.
export async function resolverUnicaAberta(resposta) {
  const abertas = await db.getOpenPendencias();
  if (abertas.length !== 1) return { resolvido: false, quantidade: abertas.length };
  await concluir(abertas[0], resposta);
  return { resolvido: true, quantidade: 1 };
}

// Sweeper: pendências velhas viram fallback (avisa cliente + registra lead).
export async function varrerTimeouts() {
  const vencidas = await db.getPendenciasVencidas(config.escalationTimeoutMin);
  for (const p of vencidas) {
    try {
      await db.expirePendencia(p.id);
      const msg =
        'Ainda estou confirmando essa informação com o Deivid. ' +
        'Pra não te deixar esperando, ele vai te retornar pessoalmente por aqui, tá? 🙏';
      await sendText(p.cliente_numero, msg);
      await pushMessage(p.cliente_numero, { role: 'assistant', content: msg });
      await appendLead({
        nome: p.cliente_nome || '',
        contato: p.cliente_numero,
        interesse: 'duvida-pendente',
        detalhes: `Pergunta sem resposta em ${config.escalationTimeoutMin}min: "${p.pergunta}"`,
        origem: 'whatsapp',
      });
      if (config.notifyNumber) {
        await sendText(
          config.notifyNumber,
          `⏰ A pendência #${p.id} de ${p.cliente_numero} passou de ${config.escalationTimeoutMin}min ` +
            `sem resposta. Avisei a pessoa que você retorna pessoalmente.\nPergunta: "${p.pergunta}"`,
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[escalation] erro no timeout da pendência', p.id, e.message);
    }
  }
}
