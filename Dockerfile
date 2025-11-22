# syntax=docker/dockerfile:1

FROM node:20-slim AS builder
WORKDIR /app

# Install pnpm via corepack
RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

FROM node:20-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
COPY public ./public

CMD ["node", "dist/webServer.js"]

