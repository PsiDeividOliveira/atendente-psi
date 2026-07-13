# Atendente de WhatsApp — Psi. Deivid Oliveira

Atendente virtual acolhedor e multitarefa para o WhatsApp profissional.
**Evolution API** (WhatsApp) + **Claude** (cérebro) + **Postgres** (base) — gerenciado
**por conversa** e com **escalação inteligente** (na dúvida, pergunta ao Deivid e aprende).

O atendente: responde dúvidas de produtos (cursos, livro, formação), acolhe quem busca
atendimento clínico e encaminha, recebe pedidos de palestra/evento/entrevista, e
**registra todo lead** — nunca deixando ninguém sem resposta. E **nunca inventa**: se
não sabe, segura o cliente, pergunta ao Deivid, repassa a resposta certa e guarda pra
próxima vez.

---

## Como funciona

```
Clientes ─┐
          ├─ WhatsApp ⇄ Evolution API ⇄ este serviço (Node) ⇄ Claude
Deivid  ──┘                                    │
        (admin por chat)                       └── Postgres (produtos, config, FAQ, leads, pendências)
```

- **Cliente** manda mensagem → atendente responde (Claude + base).
- **Deivid** manda mensagem (do número dele) → vira **admin**: gerencia tudo conversando.
- Atendente **na dúvida** → cria uma **pendência**, avisa o Deivid, segura o cliente;
  quando o Deivid responde, repassa e **salva a resposta na FAQ** (aprende).

### Papéis
| Quem | Como fala | O que faz |
|---|---|---|
| Cliente | WhatsApp normal | Tira dúvidas, é acolhido, vira lead |
| **Deivid (admin)** | WhatsApp, do número dele | "sobe o Pfister pra R$349", "me manda os leads de palestra", responde dúvidas escaladas |
| Claude Code (dev) | Só quando precisa construir | Mudanças grandes de código |

---

## Estrutura

```
atendente-whatsapp/
├── Dockerfile
├── package.json
├── .env.example
├── data/catalog.seed.json   # carga inicial (produtos) — vai pro banco no 1º boot
└── src/
    ├── index.js       # servidor + webhook + roteador (cliente/admin/escalação) + sweeper
    ├── agent.js       # agente do cliente (tools: registrar_lead, perguntar_ao_deivid)
    ├── adminAgent.js  # agente-admin (CRUD por conversa + responder pendências)
    ├── escalation.js  # segura cliente → avisa Deivid → repassa → aprende → timeout
    ├── prompt.js      # personas/regras do atendente e do admin
    ├── db.js          # Postgres: schema, seed, leitura com cache, escritas
    ├── evolution.js   # envia mensagem / "digitando" pelo WhatsApp
    ├── memory.js      # histórico de conversa por contato (RAM)
    └── config.js      # variáveis de ambiente
```

Tabelas criadas automaticamente no boot: `produtos`, `config`, `faq`, `leads`,
`pendencias`, `auditoria`.

---

## Deploy no EasyPanel (VPS Hostinger)

Tudo num projeto só (ex.: `atendente`):

### 1) Postgres
Adicione um serviço **Postgres** (template do EasyPanel). Anote a **URL interna de
conexão** (algo como `postgres://usuario:senha@postgres:5432/atendente`).

### 2) Evolution API
Adicione a **Evolution API** pelo template (sobe com Postgres/Redis próprios). Anote a
**API key global** e a **URL interna** (ex.: `http://evolution-api:8080`). Crie uma
**instância** (ex.: `deivid`) e conecte o WhatsApp:
- **WhatsApp Cloud API (oficial)** — recomendado. Sem risco de ban; o bot ganha um
  número próprio (necessário pra você mandar mensagem "pro bot" e virar admin).
- Baileys (QR) — grátis, mas usa seu número e tem risco de ban. Não recomendado.

Configure o **webhook** da instância:
- URL: `http://atendente-psi:3333/webhook?token=SEU_WEBHOOK_TOKEN`
- Evento: **messages.upsert**

### 3) Este serviço (o atendente)
Crie um **App** a partir deste repositório (Dockerfile). Porta **3333**. Variáveis:

| Variável | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | sua chave da Claude (console.anthropic.com) |
| `CLAUDE_MODEL` | `claude-sonnet-5` |
| `DATABASE_URL` | URL interna do Postgres |
| `EVOLUTION_URL` | URL interna da Evolution |
| `EVOLUTION_INSTANCE` | `deivid` |
| `EVOLUTION_API_KEY` | API key global da Evolution |
| `WEBHOOK_TOKEN` | um segredo aleatório (igual ao do webhook) |
| `ADMIN_NUMBER` | **seu número pessoal** (só dígitos, DDI). Ex.: `5534999030329` — DIFERENTE do número do bot |
| `ADMIN_PASSPHRASE` | (opcional) palavra-chave pra confirmar alterações |
| `ESCALATION_TIMEOUT_MIN` | `30` |

No **1º boot**, o banco é criado e populado com os produtos de `catalog.seed.json`.
Depois, você ajusta tudo **conversando com o admin** — não precisa mexer no banco na mão.

---

## Usando o admin (você, pelo WhatsApp)

Mande mensagem do seu número (`ADMIN_NUMBER`) pro número do bot. Exemplos:

- *"sobe o valor da sessão pra R$300"* → ele confirma antes de gravar.
- *"muda o link do curso Pfister pra https://..."*
- *"adiciona uma FAQ: 'parcela em mais de 12x?' → 'Sim, até 18x pela Hotmart'"*
- *"me manda os leads de palestra"*
- *"quais pendências estão abertas?"*
- *"responde a pendência 3: sim, atendemos aos sábados"* → repassa ao cliente e guarda.

Você também pode responder uma dúvida escalada **citando/respondendo** a mensagem de
aviso que o bot te manda — dá no mesmo.

---

## Rodar localmente (opcional)

```bash
cp .env.example .env         # preencha ANTHROPIC_API_KEY, DATABASE_URL, etc.
npm install
npm run dev
```

Precisa de um Postgres acessível na `DATABASE_URL`. Sem `ANTHROPIC_API_KEY` ele não
pensa; sem banco ele sobe mas avisa que não funciona de verdade.

---

## Observações importantes

- O atendente **não faz diagnóstico nem terapia** e tem **protocolo de crise (CVV 188)**
  fixo no `prompt.js` — questão ética/CRP, não mexer sem pensar.
- **Anti-alucinação:** ele prefere escalar a errar. Quanto mais dúvidas você responde,
  mais a FAQ cresce e menos ele precisa te perguntar.
- Respostas aprendidas são **salvas automaticamente** na FAQ; se não quiser guardar
  alguma, é só pedir ao admin ("apaga a última FAQ aprendida").
- Histórico de conversa é em RAM (some se o container reiniciar). Produtos, FAQ, leads
  e pendências ficam no Postgres (persistentes).
- `ADMIN_NUMBER` precisa ser **diferente** do número do bot (senão você não consegue
  mandar mensagem "pro bot"). Por isso a conexão **oficial (Cloud API)** é recomendada.
