FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps ./apps
COPY landing ./landing
RUN npm ci
# One service: the API, with RUN_WORKER=1 so it also runs the queue worker.
CMD ["npx", "tsx", "apps/api/src/server.ts"]
