# Meshkeep CLI image. The default command runs the replica daemon. It expects a Kubo RPC on
# its own loopback (127.0.0.1:5001), so run it inside the Kubo container's network namespace;
# see examples/docker/compose.yaml.

# Node.js 24 on Alpine, pinned by index digest.
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# The build output is plain JavaScript, so build once on the builder's own platform and copy
# the result into each target platform's image.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json LICENSE ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/kubo/package.json packages/kubo/
COPY packages/cli/package.json packages/cli/
COPY packages/extension/package.json packages/extension/
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --ignore-scripts
COPY scripts/bundle-cli.mjs scripts/
COPY packages packages
# One self-contained file, plus the licenses of everything bundled into it.
RUN node scripts/bundle-cli.mjs /out/meshkeep.mjs \
 && mkdir /out/licenses \
 && cp LICENSE /out/licenses/meshkeep.txt \
 && cp "$(dirname "$(readlink -f packages/cli/node_modules/commander/package.json)")/LICENSE" \
       /out/licenses/commander.txt \
 && cp "$(dirname "$(readlink -f packages/protocol/node_modules/multiformats/package.json)")/LICENSE" \
       /out/licenses/multiformats.txt

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="meshkeep" \
      org.opencontainers.image.description="Meshkeep CLI and replica daemon" \
      org.opencontainers.image.source="https://github.com/ericpastorm/meshkeep" \
      org.opencontainers.image.licenses="MPL-2.0"
COPY --from=build /out/ /app/
RUN mkdir -p /data/meshkeep && chown node:node /data/meshkeep \
 && printf '#!/bin/sh\nexec node /app/meshkeep.mjs "$@"\n' > /usr/local/bin/meshkeep \
 && chmod 755 /usr/local/bin/meshkeep
ENV MESHKEEP_HOME=/data/meshkeep \
    MESHKEEP_API=http://127.0.0.1:5001
USER node
VOLUME ["/data/meshkeep"]
ENTRYPOINT ["meshkeep"]
CMD ["replica", "run"]
