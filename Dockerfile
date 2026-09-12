# --- deps stage: installs dependencies only ---
# @actual-app/api depends on better-sqlite3, which tries to fetch a prebuilt
# native binary first and only falls back to compiling from source (needing
# python3/build-essential/node-gyp) when no prebuilt matches the platform.
# That fallback toolchain is only ever needed here, during install — kept in
# its own stage so it never ships in the final image.
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --production

# --- runtime stage: just the app + its already-built dependencies ---
FROM node:20-slim
WORKDIR /app

# Baked in by the publish workflow (docker/build-push-action's build-args) so
# the running app can report exactly which commit it was built from — the
# package.json version alone doesn't change often enough to tell a user
# whether they've actually pulled the latest image. Empty by default for a
# local `docker build`/`docker compose build` with no build-arg supplied.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Ensure the directories needed by the app exist
RUN mkdir -p /data /app/logs

# Expose the dashboard port
EXPOSE 3000

# Verifies the Express server is actually accepting requests, not just that
# the process is running (npm install failures etc. would still exit early).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', res => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the application
CMD ["node", "index.js"]
