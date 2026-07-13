// Agente-admin: só o número do Deivid chega aqui. Ele gerencia o sistema conversando.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildAdminPrompt } from './prompt.js';
import { getHistory, pushMessage } from './memory.js';
import * as db from './db.js';
import { resolverPorId } from './escalation.js';
import { criarEvento, criarTarefa, listarProximos } from './calendar.js';

const anthropic = new Anthropic({ apiKey: config.claude.apiKey });

const ADMIN_KEY = 'admin:' + (config.admin.number || 'x'); // chave de histórico separada

const TOOLS = [
  {
    name: 'alterar_produto',
    description: 'Altera um campo de um produto (localizado por id ou parte do nome). Confirme com o Deivid antes.',
    input_schema: {
      type: 'object',
      properties: {
        id_ou_nome: { type: 'string' },
        campo: {
          type: 'string',
          enum: ['nome', 'tipo', 'resumo', 'para_quem', 'detalhes', 'preco_avista', 'preco_parcelado', 'garantia', 'link', 'ativo'],
        },
        valor: { type: 'string' },
      },
      required: ['id_ou_nome', 'campo', 'valor'],
    },
  },
  {
    name: 'definir_config',
    description: 'Define/atualiza uma chave de configuração (ex.: valor_sessao_clinica, tom_de_voz, atendimento_horario).',
    input_schema: {
      type: 'object',
      properties: { chave: { type: 'string' }, valor: { type: 'string' } },
      required: ['chave', 'valor'],
    },
  },
  {
    name: 'adicionar_faq',
    description: 'Adiciona uma pergunta e resposta à FAQ.',
    input_schema: {
      type: 'object',
      properties: { pergunta: { type: 'string' }, resposta: { type: 'string' } },
      required: ['pergunta', 'resposta'],
    },
  },
  {
    name: 'remover_faq',
    description: 'Remove uma FAQ pelo id. Use listar_faq antes para achar o id.',
    input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'listar_faq',
    description: 'Lista as FAQs cadastradas (id, pergunta, origem). Leitura, não precisa confirmar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'listar_leads',
    description: 'Lista os últimos leads. Leitura, não precisa confirmar.',
    input_schema: {
      type: 'object',
      properties: {
        interesse: { type: 'string', enum: ['clinica', 'palestra', 'curso', 'URGENTE-CRISE', 'duvida-pendente', 'outro'] },
      },
    },
  },
  {
    name: 'listar_pendencias',
    description: 'Lista dúvidas aguardando resposta do Deivid. Leitura.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'responder_pendencia',
    description:
      'Responde uma dúvida escalada (pendência) pelo id. O sistema repassa a resposta pro cliente e guarda na FAQ. Confirme o texto com o Deivid antes.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Número da pendência (ex.: 3)' },
        resposta: { type: 'string', description: 'A resposta que será enviada ao cliente' },
      },
      required: ['id', 'resposta'],
    },
  },
  {
    name: 'agendar_compromisso',
    description:
      'Cria um compromisso com hora no Google Calendar do Deivid. Confirme os dados antes.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Título do compromisso' },
        inicio: { type: 'string', description: 'Início: "YYYY-MM-DDTHH:MM:SS" (horário de Brasília)' },
        fim: { type: 'string', description: 'Fim: "YYYY-MM-DDTHH:MM:SS". Se não souber, use início + 1h.' },
        descricao: { type: 'string', description: 'Detalhes/observações (opcional)' },
      },
      required: ['titulo', 'inicio', 'fim'],
    },
  },
  {
    name: 'criar_tarefa',
    description: 'Cria uma tarefa (evento de dia inteiro) no Google Calendar do Deivid.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        quando: { type: 'string', description: 'Dia: "YYYY-MM-DD". Se vazio, é hoje.' },
        descricao: { type: 'string' },
      },
      required: ['titulo'],
    },
  },
  {
    name: 'listar_agenda',
    description: 'Lista os próximos compromissos/tarefas. Leitura.',
    input_schema: {
      type: 'object',
      properties: { dias: { type: 'number', description: 'Quantos dias à frente (padrão 7)' } },
    },
  },
];

const ESCRITAS = new Set(['alterar_produto', 'definir_config', 'adicionar_faq', 'remover_faq', 'responder_pendencia']);

function fmtLeads(rows) {
  if (!rows.length) return 'Nenhum lead ainda.';
  return rows
    .map((r) => `#${r.id} [${r.interesse}] ${r.nome || '—'} · ${r.contato} · ${r.detalhes || ''}`.trim())
    .join('\n');
}

async function runTool(name, input, autorizado) {
  if (ESCRITAS.has(name) && !autorizado) {
    return 'BLOQUEADO: peça ao Deivid a palavra-chave de administração antes de gravar.';
  }
  try {
    switch (name) {
      case 'alterar_produto': {
        const rows = await db.updateProdutoCampo(input.id_ou_nome, input.campo, input.valor, 'deivid');
        return `OK. Atualizado em: ${rows.map((r) => r.nome).join(', ')} (${input.campo} = ${input.valor}).`;
      }
      case 'definir_config':
        await db.setConfig(input.chave, input.valor, 'deivid');
        return `OK. Config "${input.chave}" definida.`;
      case 'adicionar_faq': {
        const id = await db.addFaq(input.pergunta, input.resposta, 'manual', 'deivid');
        return `OK. FAQ #${id} adicionada.`;
      }
      case 'remover_faq':
        await db.removeFaq(input.id, 'deivid');
        return `OK. FAQ #${input.id} removida.`;
      case 'listar_faq': {
        const base = await db.loadBase();
        // loadBase não traz id; buscar direto seria melhor, mas pra manter simples listamos com origem
        return base.faq.length
          ? base.faq.map((f, i) => `${i + 1}. ${f.pergunta}`).join('\n')
          : 'Nenhuma FAQ cadastrada.';
      }
      case 'listar_leads':
        return fmtLeads(await db.listLeads({ interesse: input.interesse, limite: 20 }));
      case 'listar_pendencias': {
        const p = await db.getOpenPendencias();
        return p.length
          ? p.map((x) => `#${x.id} ${x.cliente_numero}: "${x.pergunta}"`).join('\n')
          : 'Nenhuma pendência aberta.';
      }
      case 'responder_pendencia': {
        const r = await resolverPorId(input.id, input.resposta);
        return r.ok
          ? `OK. Repassei pra pessoa (pendência #${input.id}) e guardei na FAQ.`
          : `Não deu: ${r.motivo}.`;
      }
      case 'agendar_compromisso': {
        try {
          await criarEvento(input);
          return `OK. Compromisso "${input.titulo}" agendado para ${input.inicio}.`;
        } catch (e) {
          const dica = e.message.includes('não configurada') ? ' (a agenda Google ainda não foi conectada)' : '';
          return `Não consegui agendar: ${e.message}${dica}`;
        }
      }
      case 'criar_tarefa': {
        try {
          await criarTarefa(input);
          return `OK. Tarefa "${input.titulo}" criada${input.quando ? ' para ' + input.quando : ' para hoje'}.`;
        } catch (e) {
          const dica = e.message.includes('não configurada') ? ' (a agenda Google ainda não foi conectada)' : '';
          return `Não consegui criar a tarefa: ${e.message}${dica}`;
        }
      }
      case 'listar_agenda': {
        try {
          const evs = await listarProximos({ dias: input.dias || 7 });
          return evs.length ? evs.map((x) => `• ${x.inicio} — ${x.titulo}`).join('\n') : 'Nada agendado nos próximos dias.';
        } catch (e) {
          return `Não consegui ler a agenda: ${e.message}`;
        }
      }
      default:
        return `Ferramenta desconhecida: ${name}`;
    }
  } catch (e) {
    return `Erro: ${e.message}`;
  }
}

export async function handleAdmin(number, userText, attachment = null) {
  const base = await db.loadBase();
  const system = buildAdminPrompt(base);

  const historyText = userText || (attachment
    ? (attachment.kind === 'image' ? '[imagem enviada]' : '[documento PDF enviado]')
    : '');
  await pushMessage(ADMIN_KEY, { role: 'user', content: historyText });
  const hist = await getHistory(ADMIN_KEY);

  // Palavra-chave: se configurada, precisa ter aparecido no histórico recente
  const autorizado =
    !config.admin.passphrase ||
    hist.some((m) => typeof m.content === 'string' && m.content.includes(config.admin.passphrase));

  const messages = hist.map((m) => ({ role: m.role, content: m.content }));
  while (messages.length && messages[0].role !== 'user') messages.shift();

  // Anexa mídia (imagem/PDF) na mensagem atual, se houver.
  if (attachment && messages.length) {
    const promptText = userText || 'Veja este anexo que enviei.';
    const bloco = attachment.kind === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: attachment.media_type, data: attachment.data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: attachment.data } };
    messages[messages.length - 1] = { role: 'user', content: [{ type: 'text', text: promptText }, bloco] };
  }

  let finalText = '';

  for (let round = 0; round < 5; round++) {
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
      const out = await runTool(tu.name, tu.input || {}, autorizado);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText) finalText = 'Ok.';
  await pushMessage(ADMIN_KEY, { role: 'assistant', content: finalText });
  return finalText;
}
