FROM node:22-alpine

WORKDIR /app

# Install workspace dependencies (includes tsx, pg, telegraf, vitest).
# We keep devDependencies because odt runs via tsx at runtime (no compile step).
COPY package*.json ./
COPY packages/mcp-alpaca/package.json ./packages/mcp-alpaca/
COPY packages/mcp-postgres/package.json ./packages/mcp-postgres/
RUN npm install

# Copy odt source + test + sql (sql is optional but small)
COPY odt ./odt
COPY sql ./sql

ENV NODE_ENV=production
ENV ODT_DASHBOARD_PORT=3001

# Default CMD is the dashboard; docker-compose overrides for the live service.
CMD ["npx", "tsx", "odt/src/cli/dashboard.ts"]
