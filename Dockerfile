# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json  packages/core/
COPY packages/mcp/package.json   packages/mcp/
COPY packages/cli/package.json   packages/cli/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json    packages/ui/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Reachable from outside the container; publish the port deliberately.
ENV NATS_TRAIL_HOST=0.0.0.0
ENV NATS_TRAIL_PORT=4000
ENV NATS_TRAIL_DATA=/data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/core/package.json  packages/core/
COPY --from=build /app/packages/mcp/package.json   packages/mcp/
COPY --from=build /app/packages/cli/package.json   packages/cli/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/ui/package.json    packages/ui/
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/packages/core/dist   packages/core/dist
COPY --from=build /app/packages/mcp/dist    packages/mcp/dist
COPY --from=build /app/packages/cli/dist    packages/cli/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/ui/dist     packages/ui/dist

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["serve"]
