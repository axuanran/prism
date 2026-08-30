# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

FROM ${NODE_IMAGE} AS build
ARG NODE_VERSION=24.20.0
ARG PNPM_VERSION=11.21.0
ARG PNPM_INTEGRITY=sha512.521705bce689924eac72f5a3587122f362689ef6571e55ba80076fd637c11132ecffada26fad4ea79c485bfddbfd3d5a2a5b05805a77e893de71ec8a6cca3bb1
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /src
RUN test "$(node --version)" = "v${NODE_VERSION}" \
    && corepack enable \
    && corepack prepare pnpm@${PNPM_VERSION}+${PNPM_INTEGRITY} --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:ci
RUN pnpm --filter @prismengine/host deploy --prod /out \
    && test -f /out/dist/index.js

FROM ${NODE_IMAGE} AS runtime
ARG NODE_VERSION=24.20.0
ARG PRISM_VERSION=0.1.20
ENV NODE_ENV=production
COPY --from=build --chown=10001:10001 /out /opt/prism
RUN test "$(node --version)" = "v${NODE_VERSION}" \
    && groupadd --gid 10001 prism \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent prism
LABEL org.opencontainers.image.title="Prism Engine Production Host"
LABEL org.opencontainers.image.description="Domain-neutral Prism Project control plane"
LABEL org.opencontainers.image.version="${PRISM_VERSION}"
LABEL org.opencontainers.image.licenses="Apache-2.0"
USER 10001:10001
WORKDIR /opt/prism
EXPOSE 3000
CMD ["node", "dist/index.js"]
