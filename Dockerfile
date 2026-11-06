FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY . .
# The postinstall codegen is skipped here and run explicitly once the schema is in place.
RUN bun install --frozen-lockfile --ignore-scripts \
 && bun run env:generate \
 && bun run build

FROM oven/bun:1.4.3 AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/automation.db
WORKDIR /app/apps/server
COPY --from=build --chown=bun:bun /app /app
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "run", "dist/index.mjs"]
