FROM node:25.0.0-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files
COPY package.json /app/
COPY yarn.lock /app/

# Install dependencies
RUN yarn install --production && yarn cache clean

# Copy application files
COPY . /app

# Environment
ENV NODE_ENV=production

# Healthcheck - checks if server is responding
# Default: check every 30s, timeout 3s, start after 10s, retries 3 times
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${LT_ADMIN_PORT:-80}/api/status || exit 1

# Run server (no longer needs esm loader, using native ES modules)
ENTRYPOINT ["node", "./bin/server"]
