# Use a lightweight node image
FROM node:20-slim

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
# Doing this first allows Docker to "cache" the dependencies layer
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --production

# Copy the rest of your application code
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
