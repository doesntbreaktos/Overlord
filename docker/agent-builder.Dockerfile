# Build Overlord agent binaries for multiple OS/architectures
FROM golang:1.22-bookworm AS builder
LABEL org.opencontainers.image.source="https://github.com/doesntbreaktos/Overlord"

WORKDIR /src/Overlord-Client

# Disable CGO to keep builds fully static and portable
ENV CGO_ENABLED=0

# Pre-fetch modules for faster incremental builds
COPY Overlord-Client/go.mod Overlord-Client/go.sum ./
RUN go mod download

# Bring in the full source
COPY Overlord-Client/ ./

# Default build matrix and output path (override via environment)
ENV TARGETS="windows/amd64 windows/386 windows/arm64 linux/amd64 linux/arm64 linux/arm/v7 darwin/amd64 darwin/arm64"
ENV OUT_DIR=/out

ENTRYPOINT ["/scripts/build-clients.sh"]
