FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist/server/cli.cjs ./dist/server/cli.cjs
COPY --from=build /app/dist/distribution ./dist/distribution
RUN mkdir /data && chown node:node /data
USER node
ENV SYNC_DATA_DIR=/data SYNC_HOST=0.0.0.0 SYNC_PORT=27123 SYNC_ASSETS_DIR=/app/dist/distribution
EXPOSE 27123
VOLUME ["/data"]
CMD ["node", "dist/server/cli.cjs", "start"]
