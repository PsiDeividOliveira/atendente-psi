// Agente do cliente: conversa acolhedora, registra leads e — na dúvida — escala pro Deivid.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { loadBase, appendLead } from './db.js';
import { buildSystemPrompt } from './prompt.js';
import { getHistory, pushMessage } from './memory.js';
import { abrirPendencia } from './escalation.js';
import { sendText } from './evolution.js';

const anthropic = new Anthropic({ apiKey: config.claude.apiKey });

const TOOLS = [
  {
    name: 'registrar_lead',
    description:
      'Registra um contato interessado (clínica, palestra/evento/entrevista/formação, ou crise). Use quando houver interesse concreto.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da pessoa, se souber' },
        contato: { type: 'string', description: 'Telefone/WhatsApp (número do chat)' },
        interesse: {
          type: 'string',
          enum: ['clinica', 'palestra', 'curso', 'URGENTE-CRISE', 'outro'],
        },
        detalhes: { type: 'string', description: 'Resumo do que a pessoa quer' },
      },
      required: ['interesse', 'detalhes'],
    },
  },
  {
    name: 'perguntar_ao_deivid',
    description:
      'Use quando a resposta NÃO estiver na sua base ou você não tiver certeza. Escala a dúvida pro Deivid em vez de inventar. NÃO responda o cliente por conta própria depois de usar isto — o sistema envia a resposta certa quando o Deivid responder.',
    input_schema: {
      type: 'object',
      properties: {
        pergunta: { type: 'string', description: 'A pergunta exata do cliente, reformulada de forma clara' },
      },
      required: ['pergunta'],
    },
  },
];

let onLead = null;
export function setLeadNotifier(fn) {
  onLead = fn;
}

async function runTool(name, input, ctx) {
  if (name === 'registrar_lead') {
    const lead = {
      nome: input.nome || ctx.pushName || '',
      contato: input.contato || ctx.number,
      interesse: input.interesse || 'outro',
      detalhes: input.detalhes || '',
      origem: 'whatsapp',
    };
    const res = await appendLead(lead);
    if (onLead) await onLead(lead).catch((e) => console.error('[agent] notify lead:', e.message));
    return res.ok ? 'Lead registrado.' : 'Não consegui registrar agora, mas siga a conversa.';
  }

  if (name === 'perguntar_ao_deivid') {
    const hist = await getHistory(ctx.number);
    const historico = hist
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${typeof m.content === 'string' ? m.content : '[...]'}`)
      .join('\n');
    await abrirPendencia({
      clienteNumero: ctx.number,
      clienteNome: ctx.pushName || '',
      pergunta: input.pergunta,
      contexto: historico,
    });
    return 'ESCALADO. Diga ao cliente, com acolhimento, que você vai confirmar com o Deivid e já retorna. NÃO responda a dúvida você mesmo.';
  }

  return `Ferramenta desconhecida: ${name}`;
}

// Processa uma mensagem do cliente e devolve o texto de resposta.
export async function handleCustomer(number, userText, pushName = '') {
  const base = await loadBase();
  const system = buildSystemPrompt(base);
  const ctx = { number, pushName };

  await pushMessage(number, { role: 'user', content: userText });
  const messages = (await getHistory(number)).map((m) => ({ role: m.role, content: m.content }));
  // A API exige que a 1ª mensagem seja do usuário — descarta assistant no começo da janela.
  while (messages.length && messages[0].role !== 'user') messages.shift();

  let finalText = '';

  for (let round = 0; round < 4; round++) {
    const resp = await anthropic.messages.create({
      model: config.claude.model,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages,
    });

    const textOut = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (textOut) finalText = textOut;

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: resp.content });
    const toolResults = [];
    for (const tu of toolUses) {
      const out = await runTool(tu.name, tu.input || {}, ctx);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText) finalText = 'Recebi sua mensagem! Já já te respondo. 😊';

  await pushMessage(number, { role: 'assistant', content: finalText });
  return finalText;
}
