// Agente-admin: só o número do Deivid chega aqui. Ele gerencia o sistema conversando.

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { buildAdminPrompt } from './prompt.js';
import { getHistory, pushMessage } from './memory.js';
import * as db from './db.js';
import { resolverPorId } from './escalation.js';
import {
  criarEvento, listarProximos, atualizarEvento, apagarEvento, concluirEvento, cancelarEvento,
} from './calendar.js';
import {
  criarTarefa, listarTarefas, concluirTarefa, reabrirTarefa, editarTarefa, apagarTarefa,
} from './tasks.js';
import { enviarComoDeivid } from './assinatura.js';

// maxRetries: reenvio automático em erros temporários (429/500/503/529 "Overloaded").
// Importante pra lotes grandes (ex.: 12 agendamentos numa tacada), que fazem muitas chamadas.
const anthropic = new Anthropic({ apiKey: config.claude.apiKey, maxRetries: 5 });

const ADMIN_KEY = 'admin:' + (config.admin.number || 'x'); // chave de histórico separada

// Formata data/hora no fuso de Brasília, pro Deivid ler bonito.
function fmtData(d) {
  if (!d) return '(sem data)';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
    }).format(new Date(d));
  } catch {
    return String(d);
  }
}

// Normaliza número BR (tira o 9º dígito extra) — igual ao index.js, pra bater com as pausas.
function normDig(num) {
  const d = String(num || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') return d.slice(0, 4) + d.slice(5);
  return d;
}

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
        cor: { type: 'string', description: 'Cor do evento (opcional): vermelho, laranja, amarelo, verde, azul, roxo, rosa, cinza. Use pra categorizar (ex.: consulta=vermelho, palestra=verde).' },
        recorrencia: { type: 'string', description: 'Repetição (opcional): diaria, semanal, quinzenal, mensal, anual. Só pra eventos que se repetem (ex.: consulta toda quinta).' },
        repeticoes: { type: 'number', description: 'Quantas vezes repetir (opcional). Ex.: 8 sessões.' },
        ate: { type: 'string', description: 'Repetir até esta data "YYYY-MM-DD" (opcional, alternativa a repeticoes).' },
        meet: { type: 'boolean', description: 'true = adiciona link do Google Meet ao evento. Use pra sessões/consultas ONLINE ou quando o Deivid pedir "com Meet".' },
      },
      required: ['titulo', 'inicio', 'fim'],
    },
  },
  {
    name: 'criar_tarefa',
    description:
      'Cria uma TAREFA de verdade no Google Tasks (aparece na aba Tarefas, com caixinha de concluir que o Deivid marca no celular). Use pra afazeres/lembretes, não pra compromissos com hora.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string' },
        quando: { type: 'string', description: 'Prazo (opcional): "YYYY-MM-DD". Sem isso, fica sem prazo.' },
        descricao: { type: 'string', description: 'Notas da tarefa (opcional).' },
        concluida: { type: 'boolean', description: 'Se true, já cria a tarefa marcada como concluída (check preenchido). Use quando o Deivid disser "tarefa já feita/concluída".' },
      },
      required: ['titulo'],
    },
  },
  {
    name: 'listar_tarefas',
    description: 'Lista as tarefas do Google Tasks COM o id de cada uma. Leitura. Use antes de concluir/editar/apagar.',
    input_schema: {
      type: 'object',
      properties: {
        incluir_concluidas: { type: 'boolean', description: 'Se true, mostra também as já concluídas.' },
      },
    },
  },
  {
    name: 'concluir_tarefa',
    description: 'Marca uma TAREFA como concluída (o check nativo). Ache o id com listar_tarefas.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID da tarefa (via listar_tarefas)' } },
      required: ['id'],
    },
  },
  {
    name: 'reabrir_tarefa',
    description: 'Desmarca uma tarefa concluída (volta a pendente). Ache o id com listar_tarefas.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID da tarefa (via listar_tarefas)' } },
      required: ['id'],
    },
  },
  {
    name: 'editar_tarefa',
    description: 'Altera título, prazo ou notas de uma tarefa. Ache o id com listar_tarefas.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        titulo: { type: 'string' },
        quando: { type: 'string', description: 'Novo prazo "YYYY-MM-DD".' },
        descricao: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'apagar_tarefa',
    description: 'Remove uma tarefa de vez. Confirme com o Deivid antes. Ache o id com listar_tarefas.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'listar_agenda',
    description: 'Lista os próximos compromissos/tarefas (com id de cada um). Leitura. Use antes de editar/apagar pra achar o id.',
    input_schema: {
      type: 'object',
      properties: { dias: { type: 'number', description: 'Quantos dias à frente (padrão 7)' } },
    },
  },
  {
    name: 'editar_compromisso',
    description:
      'Edita um evento existente (título, horário, descrição ou cor). Primeiro use listar_agenda pra achar o id. Confirme com o Deivid antes.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID do evento (obtido via listar_agenda)' },
        titulo: { type: 'string' },
        inicio: { type: 'string', description: 'Novo início "YYYY-MM-DDTHH:MM:SS". Ao mudar o horário, envie inicio E fim.' },
        fim: { type: 'string', description: 'Novo fim "YYYY-MM-DDTHH:MM:SS".' },
        descricao: { type: 'string' },
        cor: { type: 'string', description: 'vermelho, laranja, amarelo, verde, azul, roxo, rosa, cinza.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'concluir_evento',
    description:
      'Marca um evento/tarefa como CONCLUÍDO (fica verde com ✔️, permanece na agenda). Use listar_agenda pra achar o id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID do evento (obtido via listar_agenda)' } },
      required: ['id'],
    },
  },
  {
    name: 'cancelar_evento',
    description:
      'Marca um evento como CANCELADO (fica cinza com ❌, mas PERMANECE na agenda como registro). Diferente de apagar. Use listar_agenda pra achar o id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID do evento (obtido via listar_agenda)' } },
      required: ['id'],
    },
  },
  {
    name: 'apagar_compromisso',
    description:
      'REMOVE de vez um evento da agenda pelo id (some da agenda). Use listar_agenda pra achar o id. SEMPRE confirme com o Deivid antes — é irreversível. Se ele quer só marcar como cancelado (manter registro), use cancelar_evento.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID do evento (obtido via listar_agenda)' } },
      required: ['id'],
    },
  },
  {
    name: 'pausar_atendimento',
    description:
      'Faz o bot PARAR de responder um contato (quando o Deivid vai cuidar da conversa pessoalmente). Informe o número com DDI (ex.: 5534988887777).',
    input_schema: {
      type: 'object',
      properties: {
        contato: { type: 'string', description: 'Número do cliente, só dígitos com DDI' },
        minutos: { type: 'number', description: 'Por quantos minutos ficar em silêncio (opcional).' },
      },
      required: ['contato'],
    },
  },
  {
    name: 'retomar_atendimento',
    description: 'Faz o bot VOLTAR a responder um contato que estava pausado OU bloqueado (o Deivid liberou).',
    input_schema: {
      type: 'object',
      properties: { contato: { type: 'string', description: 'Número do cliente, só dígitos com DDI' } },
      required: ['contato'],
    },
  },
  {
    name: 'bloquear_contato',
    description:
      'BLOQUEIA um contato PERMANENTEMENTE — o bot nunca mais responde essa pessoa, até o Deivid mandar liberar (retomar_atendimento). Diferente de pausar (que expira). Use quando o Deivid disser "bloqueia pra sempre" / "não responde mais essa pessoa".',
    input_schema: {
      type: 'object',
      properties: { contato: { type: 'string', description: 'Número do cliente, só dígitos com DDI' } },
      required: ['contato'],
    },
  },
  {
    name: 'listar_pausas',
    description: 'Lista os contatos em silêncio agora (pausados ou bloqueados), com o motivo. Leitura.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'silenciar_bot',
    description:
      'Deixa o bot INOPERANTE pra todos os clientes (o Deivid continua falando com você normalmente). Informe minutos OU uma data/hora de retorno. Confirme antes.',
    input_schema: {
      type: 'object',
      properties: {
        minutos: { type: 'number', description: 'Ficar inoperante por quantos minutos (ex.: 120 = 2h).' },
        ate: {
          type: 'string',
          description: 'Alternativa: voltar a operar nesta data/hora, formato "YYYY-MM-DDTHH:MM:SS" (horário de Brasília).',
        },
        motivo: { type: 'string', description: 'Motivo (opcional), ex.: "viagem", "consultas".' },
      },
    },
  },
  {
    name: 'reativar_bot',
    description: 'Tira o bot do modo inoperante AGORA — volta a atender os clientes ("pode voltar agora").',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'status_bot',
    description: 'Diz se o bot está operando ou inoperante, e até quando. Leitura.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'enviar_mensagem',
    description:
      'Envia uma mensagem a um cliente EM NOME DO DEIVID (vai assinada como ele, não como assistente). Use quando o Deivid ditar o que quer dizer pra alguém. Confirme o texto antes de enviar.',
    input_schema: {
      type: 'object',
      properties: {
        contato: { type: 'string', description: 'Número do cliente, só dígitos com DDI' },
        texto: { type: 'string', description: 'A mensagem, exatamente como deve chegar' },
      },
      required: ['contato', 'texto'],
    },
  },
  // ---- VERBO & VISÃO (criação de vídeos) — fala com o worker de vídeos ----
  {
    name: 'videos_status',
    description: 'Status do sistema de vídeos VERBO & VISÃO: horários programados, se está pausado, fila de aprovação e quantos gerou hoje. Leitura.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'videos_publicados',
    description: 'Lista os últimos vídeos publicados no YouTube, com título, link e data. Leitura.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'videos_definir_horarios',
    description: 'Define os horários de geração diária de vídeos. A quantidade de vídeos por dia = quantidade de horários. Confirme com o Deivid antes.',
    input_schema: {
      type: 'object',
      properties: {
        horarios: { type: 'array', items: { type: 'string' }, description: 'Horários "HH:MM" (Brasília), ex.: ["07:00","19:00"]' },
      },
      required: ['horarios'],
    },
  },
  {
    name: 'videos_pausar',
    description: 'PAUSA a geração automática de vídeos (a geração manual continua disponível). Confirme antes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'videos_retomar',
    description: 'RETOMA a geração automática de vídeos nos horários programados.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'videos_gerar',
    description: 'Gera um vídeo extra AGORA (leva ~5-8 min; o vídeo chega no WhatsApp do Deivid para aprovação). Confirme antes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'videos_aprovar',
    description: 'Aprova o vídeo pendente na fila e PUBLICA no YouTube. Use quando o Deivid mandar aprovar/publicar o vídeo.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'videos_rejeitar',
    description: 'Rejeita e arquiva o vídeo pendente na fila (não publica).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'videos_agendar',
    description: 'Gera um vídeo AGORA e AGENDA a publicação no YouTube para um horário futuro (o próprio YouTube publica sozinho na hora marcada). Use quando o Deivid disser "gera agora mas posta às 14h" ou "agenda um vídeo para amanhã 9h". Confirme antes.',
    input_schema: {
      type: 'object',
      properties: {
        quando: { type: 'string', description: 'Data e hora futura no formato "YYYY-MM-DDTHH:MM:SS" (horário de Brasília). Resolva "hoje/amanhã/às 14h" para essa data completa usando a data atual.' },
      },
      required: ['quando'],
    },
  },
  {
    name: 'videos_modo_aprovacao',
    description: 'Liga/desliga a APROVAÇÃO AUTOMÁTICA dos vídeos. automatico=true: os vídeos são publicados sozinhos e o Deivid recebe só o link (sem aprovar). automatico=false: cada vídeo é enviado para o Deivid aprovar antes de publicar. Confirme antes de mudar.',
    input_schema: {
      type: 'object',
      properties: { automatico: { type: 'boolean', description: 'true = publicar sem aprovação; false = exigir aprovação' } },
      required: ['automatico'],
    },
  },
  {
    name: 'videos_playlists',
    description: 'Lista as playlists do canal do YouTube (id, nome e quantidade de vídeos). Leitura. Use para descobrir o id da playlist que o Deivid mencionou pelo nome antes de definir como padrão.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'videos_definir_playlist',
    description: 'Define a PLAYLIST padrão do YouTube onde os próximos vídeos serão salvos (fica valendo até o Deivid pedir para mudar). Passe playlist_id (pegue com videos_playlists) e o nome dela. Para criar uma playlist nova, use criar=true com o nome. Para parar de salvar em playlist, passe playlist_id vazio. Confirme antes.',
    input_schema: {
      type: 'object',
      properties: {
        playlist_id: { type: 'string', description: 'ID da playlist existente (de videos_playlists). Vazio ("") remove a playlist padrão.' },
        nome: { type: 'string', description: 'Nome da playlist (para exibição); ou o nome da nova playlist quando criar=true.' },
        criar: { type: 'boolean', description: 'true para criar uma playlist nova com esse nome e já defini-la como padrão.' },
      },
    },
  },
];

// Chama a API interna do worker de vídeos (mesmo projeto no Easypanel).
async function videoApi(caminho, metodo = 'GET', corpo = null) {
  const base = process.env.VIDEO_API_URL || 'http://psi_deivid_oliveira_verbo-visao-worker:8930';
  const resp = await fetch(base + caminho, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      'x-token': process.env.VIDEO_API_TOKEN || '',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || `worker respondeu ${resp.status}`);
  return dados;
}

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
          const r = await criarEvento(input);
          return `OK. Compromisso "${input.titulo}" agendado para ${input.inicio}.` + (r.meet ? `\n📹 Link do Meet: ${r.meet}` : '');
        } catch (e) {
          const dica = e.message.includes('não configurada') ? ' (a agenda Google ainda não foi conectada)' : '';
          return `Não consegui agendar: ${e.message}${dica}`;
        }
      }
      case 'criar_tarefa': {
        try {
          await criarTarefa(input);
          if (input.concluida) {
            return `OK. Tarefa "${input.titulo}" criada JÁ CONCLUÍDA ✔️ no Google Tasks.`;
          }
          return `OK. Tarefa "${input.titulo}" criada no Google Tasks${input.quando ? ' com prazo ' + input.quando : ''}. Você já pode marcar como concluída no celular.`;
        } catch (e) {
          return `Não consegui criar a tarefa: ${e.message}`;
        }
      }
      case 'listar_tarefas': {
        try {
          const ts = await listarTarefas({ incluirConcluidas: Boolean(input.incluir_concluidas) });
          if (!ts.length) return 'Nenhuma tarefa na lista.';
          return ts
            .map((t) => `${t.concluida ? '✔️' : '▫️'} [id:${t.id}] ${t.titulo}${t.prazo ? ' (prazo ' + t.prazo + ')' : ''}`)
            .join('\n');
        } catch (e) {
          return `Não consegui ler as tarefas: ${e.message}`;
        }
      }
      case 'concluir_tarefa': {
        try {
          await concluirTarefa(input);
          return 'OK. Tarefa marcada como concluída ✔️';
        } catch (e) {
          return `Não consegui concluir: ${e.message}`;
        }
      }
      case 'reabrir_tarefa': {
        try {
          await reabrirTarefa(input);
          return 'OK. Tarefa voltou a ficar pendente.';
        } catch (e) {
          return `Não consegui reabrir: ${e.message}`;
        }
      }
      case 'editar_tarefa': {
        try {
          await editarTarefa(input);
          return 'OK. Tarefa atualizada.';
        } catch (e) {
          return `Não consegui editar a tarefa: ${e.message}`;
        }
      }
      case 'apagar_tarefa': {
        try {
          await apagarTarefa(input);
          return 'OK. Tarefa removida.';
        } catch (e) {
          return `Não consegui apagar a tarefa: ${e.message}`;
        }
      }
      case 'listar_agenda': {
        try {
          const evs = await listarProximos({ dias: input.dias || 7 });
          return evs.length
            ? evs.map((x) => `• [id:${x.id}] ${x.inicio} — ${x.titulo}`).join('\n')
            : 'Nada agendado nos próximos dias.';
        } catch (e) {
          return `Não consegui ler a agenda: ${e.message}`;
        }
      }
      case 'editar_compromisso': {
        try {
          await atualizarEvento(input);
          return `OK. Compromisso atualizado.`;
        } catch (e) {
          return `Não consegui editar: ${e.message}`;
        }
      }
      case 'concluir_evento': {
        try {
          await concluirEvento(input);
          return `OK. Marcado como concluído (✔️ verde).`;
        } catch (e) {
          return `Não consegui concluir: ${e.message}`;
        }
      }
      case 'cancelar_evento': {
        try {
          await cancelarEvento(input);
          return `OK. Marcado como cancelado (❌ cinza), mantido na agenda.`;
        } catch (e) {
          return `Não consegui cancelar: ${e.message}`;
        }
      }
      case 'apagar_compromisso': {
        try {
          await apagarEvento(input);
          return `OK. Compromisso removido da agenda.`;
        } catch (e) {
          return `Não consegui apagar: ${e.message}`;
        }
      }
      case 'pausar_atendimento': {
        const c = normDig(input.contato);
        if (!c) return 'Preciso do número do contato (só dígitos, com DDI, ex.: 5534988887777).';
        await db.pausarContato(c, input.minutos || config.humanTakeoverPauseMin, 'pausado pelo Deivid');
        return `OK. Não vou mais responder ${c} — você assume. É só me dizer pra voltar quando terminar.`;
      }
      case 'retomar_atendimento': {
        const c = normDig(input.contato);
        if (!c) return 'Preciso do número do contato.';
        await db.retomarContato(c);
        return `OK. Voltei a responder ${c} (pausa/bloqueio removido).`;
      }
      case 'bloquear_contato': {
        const c = normDig(input.contato);
        if (!c) return 'Preciso do número do contato (só dígitos, com DDI, ex.: 5534988887777).';
        await db.bloquearContato(c, 'bloqueado permanentemente pelo Deivid');
        return `🚫 OK. ${c} BLOQUEADO permanentemente — não respondo mais essa pessoa até você mandar liberar ("volta a responder ${c}").`;
      }
      case 'listar_pausas': {
        const ps = await db.listarPausas();
        if (!ps.length) return 'Nenhum contato pausado ou bloqueado — estou respondendo todo mundo.';
        return 'Em silêncio agora:\n' + ps.map((p) => {
          const perm = /bloquead/i.test(p.motivo || '') || (p.ate && new Date(p.ate).getFullYear() > 2100);
          return `• ${p.contato} ${perm ? '🚫 BLOQUEADO' : '⏸️ pausado'} (${p.motivo || '—'})`;
        }).join('\n');
      }
      case 'silenciar_bot': {
        if (input.ate) {
          await db.silenciarAte(input.ate, input.motivo || 'silenciado pelo Deivid');
        } else if (input.minutos && Number(input.minutos) > 0) {
          await db.silenciarPorMinutos(Number(input.minutos), input.motivo || 'silenciado pelo Deivid');
        } else {
          return 'Preciso saber por quanto tempo: um número de minutos OU uma data/hora de retorno.';
        }
        // Trava: se o silêncio não ficou ativo, é porque a data/hora informada JÁ PASSOU (erro de data).
        const st = await db.statusSilencio();
        if (!st) {
          await db.reativarBot(); // limpa a entrada inválida
          return '⚠️ Não silenciei: a data/hora que calculei já passou (provável erro de data minha). Me diga de novo por quanto tempo ou até quando você quer que eu fique off (a partir de agora).';
        }
        return `OK, fiquei inoperante pros clientes AGORA. 🔇 Volto ${fmtData(st.ate)}. Você continua falando comigo normalmente; e se quiser voltar antes, é só dizer "pode voltar agora".`;
      }
      case 'reativar_bot': {
        await db.reativarBot();
        return 'OK. Voltei a atender os clientes normalmente. 👊';
      }
      case 'status_bot': {
        const st = await db.statusSilencio();
        return st
          ? `Estou INOPERANTE pros clientes até ${fmtData(st.ate)}${st.motivo ? ` (${st.motivo})` : ''}.`
          : 'Estou operando normalmente, atendendo os clientes.';
      }
      case 'enviar_mensagem': {
        const c = normDig(input.contato);
        if (!c) return 'Preciso do número do contato (só dígitos, com DDI).';
        if (!input.texto) return 'Preciso do texto da mensagem.';
        try {
          await enviarComoDeivid(c, input.texto);
          // Você entrou na conversa: eu me calo com esse contato pra não falarmos junto.
          await db.pausarContato(c, config.humanTakeoverPauseMin, 'Deivid falou pelo assistente');
          return `Enviado pro ${c} assinado como você. Já fiquei em silêncio nessa conversa pra não atrapalhar.`;
        } catch (e) {
          return `Não consegui enviar: ${e.message}`;
        }
      }
      case 'videos_status': {
        const s = await videoApi('/status');
        const fila = s.fila.length
          ? s.fila.map((v) => `• "${v.titulo}" (desde ${v.criado_em})`).join('\n')
          : 'vazia';
        return `Geração: ${s.pausado ? 'PAUSADA' : 'ativa'}${s.gerando_agora ? ' (gerando um vídeo agora)' : ''}\n` +
               `Publicação: ${s.aprovacao_automatica ? 'AUTOMÁTICA (sem aprovação, manda só o link)' : 'MANUAL (envia para o Deivid aprovar)'}\n` +
               `Playlist padrão: ${s.playlist_nome || '(nenhuma)'}\n` +
               `Horários diários: ${s.horarios.join(', ')} (${s.horarios.length} vídeo(s)/dia)\n` +
               `Gerados hoje: ${s.gerados_hoje}\nFila de aprovação: ${fila}`;
      }
      case 'videos_playlists': {
        const r = await videoApi('/playlists');
        if (!r.playlists || !r.playlists.length) return 'Nenhuma playlist no canal ainda.';
        return r.playlists
          .map((p) => `• "${p.titulo}" — ${p.qtd} vídeo(s) [id: ${p.id}]`)
          .join('\n');
      }
      case 'videos_definir_playlist': {
        const r = await videoApi('/playlist', 'POST', {
          playlist_id: input.playlist_id || '',
          nome: input.nome || '',
          criar: !!input.criar,
        });
        if (!r.playlist_id) return 'OK. Os vídeos não serão mais salvos em nenhuma playlist.';
        return `OK. Os próximos vídeos serão salvos na playlist "${r.playlist_nome || r.playlist_id}"${r.criada ? ' (criada agora)' : ''}, e isso fica valendo até você pedir para mudar.`;
      }
      case 'videos_agendar': {
        const r = await videoApi('/agendar', 'POST', { quando: input.quando });
        return r.mensagem || 'Agendamento iniciado.';
      }
      case 'videos_modo_aprovacao': {
        const r = await videoApi('/modo', 'POST', { automatico: !!input.automatico });
        return r.aprovacao_automatica
          ? 'OK. Aprovação AUTOMÁTICA ligada: os vídeos serão publicados sozinhos e o Deivid recebe só o link.'
          : 'OK. Modo MANUAL: cada vídeo será enviado para o Deivid aprovar antes de publicar.';
      }
      case 'videos_publicados': {
        const r = await videoApi('/publicados');
        if (!r.publicados.length) return 'Nenhum vídeo publicado ainda.';
        return r.publicados
          .map((v) => `• ${v.publicado_em} — "${v.titulo}"\n  ${v.url}`)
          .join('\n');
      }
      case 'videos_definir_horarios': {
        const r = await videoApi('/horarios', 'POST', { horarios: input.horarios });
        return `OK. ${r.horarios.length} vídeo(s) por dia, às ${r.horarios.join(', ')}.`;
      }
      case 'videos_pausar':
        await videoApi('/pausado', 'POST', { pausado: true });
        return 'OK. Geração automática pausada.';
      case 'videos_retomar':
        await videoApi('/pausado', 'POST', { pausado: false });
        return 'OK. Geração automática retomada.';
      case 'videos_gerar': {
        const r = await videoApi('/gerar', 'POST', {});
        return r.mensagem || 'Geração iniciada.';
      }
      case 'videos_aprovar': {
        const r = await videoApi('/aprovar', 'POST', {});
        return `Publicado no YouTube: "${r.titulo}" — ${r.url || '(link no WhatsApp)'}`;
      }
      case 'videos_rejeitar': {
        const r = await videoApi('/rejeitar', 'POST', {});
        return `Rejeitado e arquivado: "${r.titulo}".`;
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
  const pendencias = await db.getOpenPendencias().catch(() => []);
  const system = buildAdminPrompt(base, pendencias);

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
  let feitasAlgumasAcoes = false; // p/ mensagem de erro mais útil em lotes grandes

  // Até 12 rodadas: lotes grandes (ex.: 12 agendamentos) podem precisar de várias voltas.
  try {
    for (let round = 0; round < 12; round++) {
      const resp = await anthropic.messages.create({
        model: config.claude.model,
        max_tokens: 8192, // alto: lotes grandes (ex.: 12 agendamentos) emitem muitas tool-calls numa resposta só
        system,
        tools: TOOLS,
        messages,
      });
      const textOut = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (textOut) finalText = textOut;

      // Uma tool-call truncada por tamanho vem incompleta (JSON quebrado) e a API rejeita
      // se a devolvermos — então descartamos SÓ a última quando a resposta foi cortada.
      let toolUses = resp.content.filter((b) => b.type === 'tool_use');
      if (resp.stop_reason === 'max_tokens' && toolUses.length > 0) {
        console.warn(`[admin] resposta cortada por max_tokens; processando ${toolUses.length - 1} tool-calls completas`);
        toolUses = toolUses.slice(0, -1);
      }
      // Continua o loop enquanto houver tool-calls a executar (mesmo se a resposta foi cortada).
      if (toolUses.length === 0) break;

      // Reconstrói o content do assistant só com as tool-calls que vamos de fato responder,
      // pra não deixar uma tool_use sem tool_result correspondente.
      const assistantContent = resp.content.filter((b) => b.type !== 'tool_use' || toolUses.some((t) => t.id === b.id));
      messages.push({ role: 'assistant', content: assistantContent });
      const toolResults = [];
      for (const tu of toolUses) {
        const out = await runTool(tu.name, tu.input || {}, autorizado);
        feitasAlgumasAcoes = true;
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (e) {
    // Erro da API (ex.: "Overloaded" que persistiu após as retentativas).
    console.error('[admin] erro na chamada ao Claude:', e.message);
    const sobrecarga = /overload|429|529|rate/i.test(e.message || '');
    finalText =
      (finalText ? finalText + '\n\n' : '') +
      (sobrecarga
        ? '⚠️ A IA ficou sobrecarregada e não terminei tudo.' +
          (feitasAlgumasAcoes ? ' Parte pode já ter sido feita — me peça pra "listar a agenda" pra conferir o que entrou.' : '') +
          ' Tenta de novo em instantes; se for um lote grande, manda em partes menores (uns 5 por vez).'
        : `⚠️ Deu um erro aqui (${e.message}). Tenta de novo, por favor.`);
  }

  if (!finalText) finalText = 'Ok.';
  await pushMessage(ADMIN_KEY, { role: 'assistant', content: finalText });
  return finalText;
}
