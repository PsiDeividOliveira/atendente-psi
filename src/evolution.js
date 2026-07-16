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

// Rastreia ids das mensagens que o PRÓPRIO bot enviou, pra distinguir do
// Deivid respondendo manualmente (ambos chegam como fromMe no webhook).
const enviadosPeloBot = new Map(); // id -> timestamp
const ECHO_TTL_MS = 10 * 60 * 1000;
function registrarEnvio(id) {
  if (!id) return;
  const agora = Date.now();
  enviadosPeloBot.set(id, agora);
  // limpeza preguiçosa dos antigos
  for (const [k, t] of enviadosPeloBot) {
    if (agora - t > ECHO_TTL_MS) enviadosPeloBot.delete(k);
  }
}
export function foiEnviadoPeloBot(id) {
  return Boolean(id) && enviadosPeloBot.has(id);
}

// Envia mensagem de texto para um número (formato "5534999030329").
export async function sendText(number, text) {
  const resp = await evoFetch(`/message/sendText/${inst()}`, {
    number,
    text,
  });
  registrarEnvio(resp?.key?.id); // marca como "eco do bot" pra não confundir com handoff
  return resp;
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
