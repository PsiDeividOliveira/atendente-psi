// Cliente da Evolution API — envia mensagens e mostra "digitando".

import { config } from './config.js';

// Nome da instância codificado p/ URL (o nome pode ter espaços/pontos, ex.: "Whatsapp Psi.Deivid Oliveira").
const inst = () => encodeURIComponent(config.evolution.instance);

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
  return evoFetch(`/message/sendText/${inst()}`, {
    number,
    text,
  });
}

// Baixa a mídia (áudio/imagem) de uma mensagem em base64, via Evolution.
export async function getMediaBase64(messageKey) {
  const res = await fetch(
    `${config.evolution.url}/chat/getBase64FromMediaMessage/${inst()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify({ message: { key: messageKey }, convertToMp4: false }),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Evolution getBase64 => ${res.status} ${txt.slice(0, 200)}`);
  }
  const j = await res.json();
  return { base64: j.base64 || j.media || '', mimetype: j.mimetype || j.mimeType || '' };
}

// Mostra o status "digitando..." por alguns ms (deixa o bot mais humano).
export async function sendTyping(number, ms = 1200) {
  try {
    await evoFetch(`/chat/sendPresence/${inst()}`, {
      number,
      presence: 'composing',
      delay: ms,
    });
  } catch {
    // presença é cosmética; ignora falha
  }
}
