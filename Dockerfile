# Dockerfile — the self-hosting path.
#
# Builds the image behind docker-compose.yml. This runs the web server ONLY:
# Claude Desktop reaches it separately by exec-ing src/stdio-bridge.js into the
# running container. See src/server.js for why that split exists.
#
# Most users never touch this. The Claude Desktop extension (build-mcpb.mjs) is
# the supported path and needs neither Docker nor Node installed.

FROM node:22-alpine

WORKDIR /app

# Dependencies first, in their own layer. Docker caches this step and only
# reruns it when package.json changes, so day-to-day source edits rebuild in
# seconds rather than reinstalling express and ws every time.
COPY package.json ./
RUN npm install --omit=dev


# Source after dependencies, for the same caching reason: these change often and
# invalidate only the layers below them.
COPY src ./src
COPY public ./public
COPY tracks ./tracks


# Read by src/server.js. Also the port docker-compose.yml publishes.
ENV PORT=3044
EXPOSE 3044

# The web server. Not the stdio bridge, which is launched per conversation by
# Claude Desktop via `docker exec` and exits with it.
CMD ["node", "src/server.js"]
