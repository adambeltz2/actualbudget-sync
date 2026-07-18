# Use a lightweight node image
FROM node:20-slim

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
# Doing this first allows Docker to "cache" the dependencies layer
COPY package*.json ./
RUN npm install --production

# Copy the rest of your application code
COPY . .

# Ensure the directories needed by the app exist
RUN mkdir -p /data /app/logs

# Expose the dashboard port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]