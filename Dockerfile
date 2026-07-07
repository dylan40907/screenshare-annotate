# Sync server image. Only the WebSocket relay ships here - the desktop app is
# distributed separately as an installer.
FROM node:20-alpine

WORKDIR /app

# Install only production deps (ws). Electron/electron-builder are devDeps and skipped.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server ./server

ENV PORT=4321
EXPOSE 4321

# Optional: set JOIN_TOKEN at runtime to require ?token=... from clients.
CMD ["node", "server/server.js"]
