FROM node:20-slim

RUN apt-get update && apt-get install -y git curl python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p uploads data .pi/agent/skills

CMD ["node", "src/index.js"]
