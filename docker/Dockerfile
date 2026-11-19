# ChampManOnline app image: Fastify API + React site + self-hosted js-dos.
# Build from the repo root:  docker buildx build --platform linux/amd64 -f docker/Dockerfile -t champmanonline .

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps ./apps
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    GAMES_ROOT=/games \
    WEB_DIR=/app/apps/web/dist \
    CATALOG_PATH=/app/games/catalog.json
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/api && npm cache clean --force
COPY apps/api/src ./apps/api/src
COPY games/catalog.json ./games/catalog.json
COPY --from=build /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/api/src/server.ts"]
