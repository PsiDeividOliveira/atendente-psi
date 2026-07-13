// Transcrição de áudio (o "ouvido" do bot).
// Usa a OpenRouter mandando o áudio pra um modelo multimodal (Gemini) que transcreve.
// O Claude segue sendo o cérebro — aqui só transformamos áudio em texto.

import { config } from './config.js';

// Recebe base64 do áudio + formato (ogg/mp3/m4a...) e devolve a transcrição em texto.
export async function transcribeAudio(base64, format = 'ogg') {
  if (!config.openrouter.apiKey) {
    throw new Error('OPENROUTER_API_KEY não configurada');
  }
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://psideividoliveira.com',
      'X-Title': 'Atendente Psi Deivid',
    },
    body: JSON.stringify({
      model: config.openrouter.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcreva este áudio em português do Brasil. Responda APENAS com a transcrição literal do que foi falado, sem comentários, sem aspas, sem prefixos.',
            },
            { type: 'input_audio', input_audio: { data: base64, format } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}
