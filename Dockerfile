# Usa o Node.js versão 18 (leve — baseado no Alpine Linux)
FROM node:18-alpine

# Define a pasta de trabalho dentro do container
WORKDIR /app

# Copia os arquivos do projeto para dentro do container
COPY package.json .
COPY server.js .
COPY public/ ./public/

# Cria a pasta de dados (os dados reais ficam fora via volume)
RUN mkdir -p data

# Informa que o servidor usa a porta 3000
EXPOSE 3000

# Comando que inicia o servidor quando o container ligar
CMD ["node", "server.js"]
