# LiveKit v1.13.7, linux/amd64. Digest resolved from Docker Hub on 2026-10-06.
# The Fly Machines used by this lane are amd64; change the pin only in a reviewed
# S0/maintenance PR and update scripts/validate-livekit-r1-sfu.mjs with it.
FROM livekit/livekit-server:v1.13.7@sha256:5d3dcc475d064536d9948ebe4eeab8e3b24d6f07a46f6d71a3415a2901bbdc52

# The stock image is Alpine-based. `getent` is supplied by musl-utils and is
# deliberately required by entrypoint.sh for the S0-F1 UDP-binding assertion.
RUN apk add --no-cache musl-utils

COPY livekit.yaml.tmpl /etc/livekit/livekit.yaml.tmpl
COPY entrypoint.sh /usr/local/bin/livekit-r1-entrypoint
# Docker build contexts copied from a Windows checkout can retain CRLF; remove
# it defensively so the shell shebang never becomes /bin/sh\\r on Fly.
RUN sed -i 's/\r$//' /etc/livekit/livekit.yaml.tmpl /usr/local/bin/livekit-r1-entrypoint \
 && chmod 0755 /usr/local/bin/livekit-r1-entrypoint

ENTRYPOINT ["/usr/local/bin/livekit-r1-entrypoint"]
