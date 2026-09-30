# A dedicated public-lobby host: the Halo browser build in headless Chromium.
# Build from the repository root or this directory; nothing from the game is
# copied in, the container loads the deployed page like a player does.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY config.mjs host.mjs ./

ENV NODE_ENV=production
# The image ships the Chromium this playwright-core version expects, under
# PLAYWRIGHT_BROWSERS_PATH, so no browser download happens at build or run.
ENV HALO_STATUS_PORT=8790
EXPOSE 8790

USER pwuser
CMD ["node", "host.mjs"]
