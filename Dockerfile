FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm install tsx
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
