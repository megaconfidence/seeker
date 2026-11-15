# The UI build only produces static files, so run it natively when cross-building.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine
RUN apk add --no-cache ffmpeg chromaprint tini su-exec
WORKDIR /app
ENV NODE_ENV=production \
    SEEKER_PORT=7335 \
    SEEKER_DATA_DIR=/data \
    SEEKER_DOWNLOADS_DIR=/downloads \
    SEEKER_MUSIC_DIR=/music \
    SEEKER_IMPORT_DIR=/import
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY LICENSE ./LICENSE
COPY --from=build /app/web/dist ./web/dist
COPY docker-entrypoint.sh /usr/local/bin/seeker-entrypoint
RUN chmod 755 /usr/local/bin/seeker-entrypoint && mkdir -p /data && chown node:node /data
# The commit this image was built from, shown in Settings and by MCP get_status. Declared last so
# a new commit doesn't invalidate the cached layers above.
ARG SEEKER_COMMIT=""
ENV SEEKER_COMMIT=$SEEKER_COMMIT
LABEL org.opencontainers.image.licenses="MIT"
EXPOSE 7335
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:7335/healthz >/dev/null || exit 1
# The container starts as root so the entrypoint can give /data to PUID:PGID; Seeker itself then
# runs as that user (see docker-entrypoint.sh).
ENTRYPOINT ["/sbin/tini", "--", "seeker-entrypoint"]
CMD ["node", "server/index.ts"]
