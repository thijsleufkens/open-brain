# === Stage 1: Build ===
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# === Stage 2: Runtime ===
FROM node:22-slim AS runtime

WORKDIR /app

# Create non-root user
RUN groupadd --gid 1001 openbrain && \
    useradd --uid 1001 --gid openbrain --create-home openbrain

# Copy built app and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create data directory with correct ownership
RUN mkdir -p /data && chown openbrain:openbrain /data

# Switch to non-root user
USER openbrain

# Default environment
ENV NODE_ENV=production
ENV DB_PATH=/data/brain.db
ENV MCP_PORT=3000
ENV LOG_LEVEL=info

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/mcp-http.js"]
