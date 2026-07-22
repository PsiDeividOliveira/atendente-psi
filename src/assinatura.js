// Assinatura nas mensagens que vão pro CLIENTE, pra ele saber com quem está falando:
// se foi o assistente virtual ou se é conteúdo do próprio Deivid.
// Igual os CRMs fazem: uma linha em negrito no topo da mensagem.
//
// Editável por conversa: definir_config("assinatura_bot", "...") — string vazia desliga.

import { loadBase } from './db.js';
import { sendText } from './evolution.js';

const PADRAO_BOT = '🤖 *Assistente virtual*';
const PADRAO_DEIVID = '👤 *Deivid Oliveira*';

async function etiqueta(chave, padrao) {
  try {
    const base = await loadBase();
    const v = (base.config || {})[chave];
    return v === undefined || v === null ? padrao : v; // "" = sem etiqueta
  } catch {
    return padrao;
  }
}

function juntar(etq, texto) {
  const e = String(etq || '').trim();
  return e ? `${e}\n${texto}` : texto;
}

// Mensagem gerada pelo assistente.
export async function enviarComoBot(numero, texto) {
  return sendText(numero, juntar(await etiqueta('assinatura_bot', PADRAO_BOT), texto));
}

// Mensagem cujo CONTEÚDO é do Deivid (ex.: resposta escalada que o bot só repassa).
export async function enviarComoDeivid(numero, texto) {
  return sendText(numero, juntar(await etiqueta('assinatura_deivid', PADRAO_DEIVID), texto));
}
