// Memória de conversa por contato — agora PERSISTENTE no Postgres.
// Sobrevive a reinícios/deploys, dá contexto real ao agente e reduz alucinação.
// Guarda as últimas N mensagens (user/assistant) por contato.

import { appendHistorico, getHistorico, limparHistorico } from './db.js';

const MAX_MSGS = 20; // quantas mensagens de contexto o agente enxerga

// Retorna o histórico recente do contato (ordem cronológica).
export async function getHistory(contato) {
  try {
    return await getHistorico(contato, MAX_MSGS);
  } catch (e) {
    console.error('[memory] erro lendo histórico:', e.message);
    return [];
  }
}

// Salva uma mensagem no histórico. content é sempre texto simples aqui
// (o loop de tool-use monta os blocos localmente e não é persistido).
export async function pushMessage(contato, message) {
  try {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    await appendHistorico(contato, message.role, content);
  } catch (e) {
    console.error('[memory] erro salvando mensagem:', e.message);
  }
}

export async function resetHistory(contato) {
  try {
    await limparHistorico(contato);
  } catch (e) {
    console.error('[memory] erro limpando histórico:', e.message);
  }
}
