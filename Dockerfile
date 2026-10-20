FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
# Same image runs both processes: default CMD is the API; the worker overrides it (see render.yaml).
CMD ["npx", "tsx", "apps/api/src/server.ts"]
