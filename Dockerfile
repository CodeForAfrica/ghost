FROM ghost:6.5.3-alpine

# Add the Object Store storage adapter
# We use the main branch of the repository
ADD --chown=node:node https://github.com/CodeForAfrica/ghost-object-store-storage-adapter.git#dev content/adapters/storage/object-store

# Install dependencies for the storage adapter
WORKDIR /var/lib/ghost/content/adapters/storage/object-store
RUN npm install --omit=dev

# Return to the original working directory
WORKDIR /var/lib/ghost
