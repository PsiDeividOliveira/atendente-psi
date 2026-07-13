// Memória de conversa por contato (em RAM).
// Guarda o histórico recente pra dar contexto ao Claude.
// Simples de propósito: reinicia se o container reiniciar. Se precisar
// de persistência real depois, trocamos por Redis (já vem no stack da Evolution).

const conversas = new Map(); // number -> { messages: [...], updatedAt }

const MAX_MSGS = 20; // últimas N mensagens (user+assistant) mantidas
const TTL_MS = 1000 * 60 * 60 * 6; // esquece conversa após 6h de silêncio

export function getHistory(number) {
  const c = conversas.get(number);
  if (!c) return [];
  if (Date.now() - c.updatedAt > TTL_MS) {
    conversas.delete(number);
    return [];
  }
  return c.messages;
}

export function pushMessage(number, message) {
  const c = conversas.get(number) || { messages: [], updatedAt: Date.now() };
  c.messages.push(message);
  // mantém só as últimas MAX_MSGS
  if (c.messages.length > MAX_MSGS) {
    c.messages = c.messages.slice(-MAX_MSGS);
  }
  c.updatedAt = Date.now();
  conversas.set(number, c);
}

export function resetHistory(number) {
  conversas.delete(number);
}
