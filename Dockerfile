# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p celeris-cli \
    && install -Dm755 target/release/celeris /out/celeris

# ---- runtime ----------------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /var/lib/celeris --create-home celeris \
    && install -d -o celeris /var/lib/celeris/data
COPY --from=build /out/celeris /usr/local/bin/celeris

USER celeris
WORKDIR /var/lib/celeris
# Every setting can also come from a mounted celeris.toml (`--config`).
ENV CELERIS_HTTP_LISTEN=0.0.0.0:8080 \
    CELERIS_DATA_DIR=/var/lib/celeris/data \
    CELERIS_LOG_FORMAT=json
VOLUME ["/var/lib/celeris/data"]
EXPOSE 8080 7000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["celeris", "--addr", "http://127.0.0.1:8080", "status"]

# tini forwards SIGTERM so the node shuts down gracefully (flushes, leaves).
ENTRYPOINT ["tini", "--", "celeris"]
CMD ["start"]
