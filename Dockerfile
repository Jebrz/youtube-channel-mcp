# Remote connector image for youtube-channel-mcp (serve-http).
# Contains NO credentials: Google and OAuth secrets are injected at runtime
# as environment variables / secrets by the hosting platform.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    YT_MCP_HTTP_HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js", "serve-http"]
