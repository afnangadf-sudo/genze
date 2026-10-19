# Genze API — production image for Render (free tier).
FROM node:22-slim AS build
RUN npm install -g pnpm
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @genze/api... 2>/dev/null || pnpm install --filter @genze/api...
RUN pnpm --filter @genze/api build

FROM node:22-slim AS run
WORKDIR /app
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/migrations ./migrations
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/index.js"]
