# Atendente Psi. Deivid Oliveira — imagem de produção
FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (cache de camada)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o código
COPY . .

ENV NODE_ENV=production
EXPOSE 3333

CMD ["node", "src/index.js"]
