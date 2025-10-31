FROM ghost:6.5.3-alpine

# Add the Object Store storage adapter
ADD https://github.com/CodeForAfrica/ghost-object-store-storage-adapter.git content/adapters/storage/object-store

# Install dependencies for the storage adapter
WORKDIR /var/lib/ghost/content/adapters/storage/object-store
RUN npm install --omit=dev

# Return to the original working directory
WORKDIR /var/lib/ghost

# Start Ghost
CMD ["node", "current/index.js"]
