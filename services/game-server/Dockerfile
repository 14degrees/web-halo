# The native dedicated server: Halo's Linux build with the browser's
# virtual sockets (ninja server), and the Go gateway that carries them over
# WebRTC. Build from the repository root:
#   docker build --platform linux/amd64 -f services/game-server/Dockerfile .
# The game data (maps/) is not in the image; mount it at /data.

FROM debian:trixie AS game
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
      clang lld python3 ninja-build gcc-multilib libc6-dev-i386 libsdl3-dev:i386 ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY configure.py ./
COPY config/ config/
COPY libs/ libs/
COPY tools/ tools/
COPY source/ source/
COPY port/ port/
# (port/web/assets is the browser build's, which configure.py watches)
RUN mkdir -p port/web/assets && python3 configure.py --release --portable --lto thin --pgo off && ninja server

FROM golang:1.25-trixie AS gateway
WORKDIR /gateway
COPY services/game-server/gateway/go.mod services/game-server/gateway/go.sum ./
RUN go mod download
COPY services/game-server/gateway/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /halo-gateway .

FROM debian:trixie-slim
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
      libsdl3-0:i386 libc6:i386 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=game /src/build/server/halo-server /opt/halo/halo-server
COPY --from=gateway /halo-gateway /opt/halo/halo-gateway
RUN useradd --system --home /var/lib/halo --create-home halo && mkdir -p /data && chown halo:halo /data
USER halo
ENV HALO_SERVER_BINARY=/opt/halo/halo-server HALO_DATA_ROOT=/data HALO_SAVE_ROOT=/var/lib/halo/save
EXPOSE 8790 40100/udp
ENTRYPOINT ["/opt/halo/halo-gateway"]
