# Render builds with this Dockerfile. Node 22 LTS slim image.
FROM node:22-alpine

WORKDIR /app

# Install deps separately so layer caches when only source changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Start the API. The HTTP server listens on $PORT.
CMD ["node", "src/server.js"]
