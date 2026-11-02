# CySOC portal image: the same image runs the web server, the worker and migrations.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY server ./server
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production WEB_DIR=/app/dist/web STORAGE_DIR=/data/reports PORT=8080
WORKDIR /app
RUN groupadd --system portal && useradd --system --gid portal --home /app portal \
 && mkdir -p /data/reports && chown portal:portal /data/reports
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER portal
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/src/index.js"]
