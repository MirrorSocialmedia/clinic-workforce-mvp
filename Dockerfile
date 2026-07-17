# Stage 1: Builder
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY . .
RUN rm -f pnpm-workspace.yaml apps/web/pnpm-workspace.yaml
WORKDIR /app/apps/web
RUN pnpm install --frozen-lockfile
RUN npx prisma generate
ENV DATABASE_URL="postgresql://build:build@build:5432/build" \
 JWT_SECRET="build-time-placeholder-0123456789abcdefghij" \
 NODE_OPTIONS="--max-old-space-size=1024"
RUN pnpm build

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
