# Stage 1: Builder
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
# ★ 2026-10-04 快 deploy：先淨係 copy 依賴清單 → 裝依賴（layer cache）→ 再 copy 源碼。
#   之前 `COPY . .` 喺 install 前面 → 改一個字都令 pnpm install 由頭嚟過；
#   而家 package.json／pnpm-lock.yaml／schema 冇改，install 同 prisma generate 直接用 cache。
#   （install 只喺 apps/web 做，同之前一樣冇 pnpm-workspace.yaml）
COPY apps/web/package.json apps/web/pnpm-lock.yaml /app/apps/web/
WORKDIR /app/apps/web
RUN pnpm install --frozen-lockfile
COPY apps/web/prisma ./prisma
RUN npx prisma generate
WORKDIR /app
COPY . .
RUN rm -f pnpm-workspace.yaml apps/web/pnpm-workspace.yaml
WORKDIR /app/apps/web
ENV DATABASE_URL="postgresql://build:build@build:5432/build" \
 JWT_SECRET="build-time-placeholder-0123456789abcdefghij" \
 NODE_OPTIONS="--max-old-space-size=4096"
# ★ 2026-10-04 快 deploy：保留 Next 編譯快取（BuildKit cache mount，唔入 image）→ 細改動唔使全部重新編譯
RUN --mount=type=cache,id=cwm-next-cache,target=/app/apps/web/.next/cache pnpm build

# Stage 2: Runner
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
RUN npm i -g prisma@6.19.3
RUN addgroup --system --gid 1001 nodejs && \
 adduser --system --uid 1001 nextjs
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./.next/static
COPY --from=builder /app/apps/web/prisma ./apps/web/prisma
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
