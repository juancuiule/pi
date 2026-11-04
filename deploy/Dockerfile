# One image for the server and the console; docker-compose.yml runs each with its own command.
FROM node:26.7.0-bookworm-slim

# The server drives the host's Docker (sandboxes, their volumes, Software builds) through the mounted socket.
COPY --from=docker:29.8.1-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29.8.1-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN npm install --global pnpm@12.10.1

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node patches patches
COPY --chown=node:node web/package.json web/package.json
# No install scripts: the only ones install git hooks (lefthook) or check binaries; sharp and canvas ship prebuilt.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY --chown=node:node . .
RUN pnpm --filter web build && mkdir -p data
