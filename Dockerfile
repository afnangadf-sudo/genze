FROM node:22-slim AS build
RUN npm install -g pnpm
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @genze/web... 2>/dev/null || pnpm install --filter @genze/web...
RUN pnpm --filter @genze/web build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 7860
CMD ["sh", "-c", "printf 'window.__GENZE_API_URL = \"%s\";' \"$API_URL\" > apps/web/public/runtime-config.js && PORT=7860 node apps/web/server.js"]
