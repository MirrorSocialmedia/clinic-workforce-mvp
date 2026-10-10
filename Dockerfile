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
# ⚠️ 2026-10-04：唔好用 `RUN --mount=type=cache`（BuildKit 專用）—— production server 用舊式 builder，
#   會報「the --mount option requires BuildKit」令 deploy 停喺 build。依賴層 cache（上面）兩種 builder 都得。
RUN pnpm build
# ★ cwm-labdoc：pdfjs／@napi-rs/canvas 係 runtime 原生 import（webpackIgnore）→ Next standalone 打包跟唔齊
#   （2026-10-10 生產：Cannot find module …/pdfjs-dist/legacy/build/pdf.worker.mjs；修完 worker 再撞
#   @napi-rs/canvas「Cannot find native binding」）→ 喺 builder 抄一份完整（跟 symlink 抄真檔）俾 runner 用。
RUN mkdir -p /labdoc-modules/@napi-rs \
 && cp -rL node_modules/pdfjs-dist /labdoc-modules/pdfjs-dist \
 && rm -rf /labdoc-modules/pdfjs-dist/web /labdoc-modules/pdfjs-dist/types /labdoc-modules/pdfjs-dist/build /labdoc-modules/pdfjs-dist/image_decoders \
 && find /labdoc-modules -name '*.map' -delete \
 && cp -rL node_modules/@napi-rs/canvas /labdoc-modules/@napi-rs/canvas \
 && for d in node_modules/.pnpm/node_modules/@napi-rs/canvas-*; do [ -e "$d" ] && cp -rL "$d" /labdoc-modules/@napi-rs/; done; \
 ls /labdoc-modules/@napi-rs

# Stage 2: Runner
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# labdoc 渲染：中文單據需要 CJK 字型（font-noto-cjk）；fontconfig 提供 fallback 機制
# （base-14 非嵌入字體都靠 system fallback；嵌入 subset 字體唔受影響 — 見 gen-labdoc-fixtures.mjs gen3 註記）
RUN apk add --no-cache openssl fontconfig font-noto-cjk
RUN npm i -g prisma@6.19.3
RUN addgroup --system --gid 1001 nodejs && \
 adduser --system --uid 1001 nextjs
# cwm-labdoc：Lab 單據存檔目錄要 nextjs 寫得（named volume 第一次建立時會跟呢個目錄嘅擁有人；
#   冇呢行 volume 係 root 擁有 → 上傳 EACCES）
RUN mkdir -p /data/lab-docs && chown nextjs:nodejs /data/lab-docs
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./.next/static
COPY --from=builder /app/apps/web/prisma ./apps/web/prisma
# ★ cwm-labdoc：完整 pdfjs-dist／@napi-rs/canvas（＋平台 binary）蓋過 standalone 嘅不完整版本
#   （standalone 入面可能係 symlink → 先刪再抄；rm 只會刪 link 本身）。最後自檢：載唔到就 build 失敗。
COPY --from=builder /labdoc-modules /tmp/labdoc-modules
RUN cd /tmp/labdoc-modules && for p in pdfjs-dist @napi-rs/*; do \
      rm -rf "/app/node_modules/$p"; mkdir -p "$(dirname "/app/node_modules/$p")"; cp -r "$p" "/app/node_modules/$p"; \
    done && rm -rf /tmp/labdoc-modules \
 && cd /app && node -e "require('@napi-rs/canvas'); import('pdfjs-dist/legacy/build/pdf.worker.mjs').then(() => import('pdfjs-dist/legacy/build/pdf.mjs')).then(() => console.log('labdoc deps OK')).catch((e) => { console.error(e); process.exit(1) })"
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
