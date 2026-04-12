FROM node:22-slim AS base
RUN corepack enable pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
COPY tsconfig.json ./
RUN pnpm run build

FROM node:22-slim
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=base /app/dist/ ./dist/

CMD ["node", "dist/cli/index.js", "serve"]
