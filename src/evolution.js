// Cliente da Evolution API — envia mensagens e mostra "digitando".

import { config } from './config.js';

async function evoFetch(path, body) {
  const res = await fetch(`${config.evolution.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.evolution.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Evolution ${path} => ${res.status} ${txt}`);
  }
  return res.json().catch(() => ({}));
}

// Envia mensagem de texto para um número (formato "5534999030329").
export async function sendText(number, text) {
  return evoFetch(`/message/sendText/${config.evolution.instance}`, {
    number,
    text,
  });
}

// Mostra o status "digitando..." por alguns ms (deixa o bot mais humano).
export async function sendTyping(number, ms = 1200) {
  try {
    await evoFetch(`/chat/sendPresence/${config.evolution.instance}`, {
      number,
      presence: 'composing',
      delay: ms,
    });
  } catch {
    // presença é cosmética; ignora falha
  }
}
