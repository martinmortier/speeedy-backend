FROM node:20-alpine

# better-sqlite3 needs build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

# /data is provided by a named volume mounted via custom_docker_run_options in Coolify.
# Intentionally NOT declared as VOLUME here to avoid creating anonymous volumes
# that take precedence and lose data across redeploys.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/server.js"]
