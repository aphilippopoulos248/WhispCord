# Build from the repo root: docker build -f apps/orchestrator/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/orchestrator/package.json apps/orchestrator/
RUN npm ci --workspace @whispcord/orchestrator --include-workspace-root
COPY packages/shared packages/shared
COPY apps/orchestrator apps/orchestrator
RUN npm run build -w @whispcord/orchestrator

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/orchestrator/package.json apps/orchestrator/
RUN npm ci --omit=dev --workspace @whispcord/orchestrator && npm cache clean --force
COPY --from=build /app/apps/orchestrator/dist apps/orchestrator/dist
USER node
EXPOSE 8787
CMD ["node", "apps/orchestrator/dist/server.js"]
