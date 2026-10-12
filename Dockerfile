FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
