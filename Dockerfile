FROM node:22-bookworm AS dependencies

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        ffmpeg \
        libzmq5 \
        python3 \
        python3-venv \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/yt-dlp/bin/pip install --no-cache-dir \
        "yt-dlp[default,curl-cffi]" \
        "yt-dlp-getpot-wpc==1.1.2" \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && /opt/yt-dlp/bin/python -c "import yt_dlp_plugins.extractor.getpot_wpc" \
    && yt-dlp --version \
    && yt-dlp --list-impersonate-targets | grep -qi chrome \
    && chromium --version \
    && ffmpeg -version

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN chmod 0755 docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["./docker-entrypoint.sh"]
