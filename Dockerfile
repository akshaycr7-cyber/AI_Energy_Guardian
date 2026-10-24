# syntax=docker/dockerfile:1

# Stage 1: Build TypeScript application
FROM node:22-alpine AS builder
WORKDIR /app

# Install dependencies reproducibly (uses npm ci when package-lock.json is present)
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install --no-audit --no-fund; \
    fi

# Copy TypeScript sources and compile to ./dist, then strip devDependencies
COPY tsconfig.json server.ts ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force

# Stage 2: Minimal non-root production runtime for Google Cloud Run
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy ESM package manifest, production dependencies, compiled server, and required runtime assets
COPY --chown=node:node --from=builder /app/package.json ./package.json
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node dashboard ./dashboard
COPY --chown=node:node src/historical_dataset.json ./src/historical_dataset.json

USER node

# Cloud Run supplies PORT dynamically at runtime (default 8080)
EXPOSE 8080

CMD ["node", "dist/server.js"]
