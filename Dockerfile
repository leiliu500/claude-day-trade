FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
COPY packages/mcp-alpaca/package.json ./packages/mcp-alpaca/
COPY packages/mcp-postgres/package.json ./packages/mcp-postgres/
RUN npm install

# Copy source
COPY . .

# Build all packages
RUN npm run build --workspaces --if-present
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/sql ./sql
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
