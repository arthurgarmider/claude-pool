FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/server packages/server

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app .
EXPOSE 3847
ENV DB_PATH=/data/claude-pool.db
VOLUME /data
CMD ["bun", "run", "packages/server/src/index.ts"]
