# --- Stage 1: Builder (creates an environment to install all dependencies) ---
FROM node:25.0.0-alpine AS builder
WORKDIR /app

# Copy and install dependencies
# We copy package files first to leverage Docker's build cache.
# This step includes dev dependencies and production dependencies.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile && yarn cache clean

# Copy the application source code
COPY server.js ./
COPY lib/ ./lib/
COPY bin/ ./bin/

# --- Stage 2: Production (creates the final, smaller image) ---
FROM node:25.0.0-alpine
WORKDIR /app

# Install curl in the final image, as it's needed for the healthcheck
RUN apk add --no-cache curl

# Copy only what is necessary to run the application from the 'builder' stage
# This ensures a much smaller final image.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/yarn.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js ./
COPY --from=builder /app/lib/ ./lib/
COPY --from=builder /app/bin/ ./bin/

# Environment
ENV NODE_ENV=production

# Healthcheck - checks if the server is responding
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${LT_PORT:-80}/healthz || exit 1

# Run server (native ES modules are supported)
ENTRYPOINT ["node", "./bin/server.mjs"]
