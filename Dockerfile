FROM node:22-alpine

WORKDIR /app

# Copy package manifests first for optimal layer caching
COPY package.json ./

# Install production dependencies only
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY server.js ./
COPY src ./src
COPY public ./public

# Create persistent data directory owned by non-root node user (uid 1000)
RUN mkdir -p /app/data/projects /app/data/backups && chown -R node:node /app/data

USER node

ENV NODE_ENV=production
ENV PORT=28085
ENV DATA_DIR=/app/data

EXPOSE 28085

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:28085/api/health || exit 1

CMD ["node", "server.js"]
