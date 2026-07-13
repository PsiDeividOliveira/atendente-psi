// Configuração central — lê variáveis de ambiente com defaults seguros.

function warnIfEmpty(name) {
  if (!process.env[name]) console.warn(`[config] variável ${name} não definida`);
}
['ANTHROPIC_API_KEY', 'DATABASE_URL', 'EVOLUTION_API_KEY', 'ADMIN_NUMBER'].forEach(warnIfEmpty);

const digits = (s) => (s || '').replace(/\D/g, '');

export const config = {
  port: Number(process.env.PORT || 3333),

  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  },

  db: {
    url: process.env.DATABASE_URL || '',
  },

  evolution: {
    url: (process.env.EVOLUTION_URL || 'http://evolution-api:8080').replace(/\/$/, ''),
    instance: process.env.EVOLUTION_INSTANCE || 'deivid',
    apiKey: process.env.EVOLUTION_API_KEY || '',
  },

  webhookToken: process.env.WEBHOOK_TOKEN || '',

  admin: {
    // Número pessoal do Deivid (só ele vira admin). Formato: 5534999030329
    number: digits(process.env.ADMIN_NUMBER),
    // Palavra-chave opcional pra confirmar alterações sensíveis (deixe vazio p/ desligar)
    passphrase: process.env.ADMIN_PASSPHRASE || '',
  },

  // Pra onde vão avisos de lead/escalação. Padrão = número do admin.
  get notifyNumber() {
    return digits(process.env.NOTIFY_NUMBER) || this.admin.number;
  },

  // Minutos até o cliente receber o fallback caso o Deivid não responda a escalação
  escalationTimeoutMin: Number(process.env.ESCALATION_TIMEOUT_MIN || 30),

  // Segundos de cache da base antes de reler do banco (invalidado em cada escrita)
  cacheTtl: Number(process.env.CACHE_TTL || 60),
};
