ARG GHOST_VERSION=6.7.0
FROM ghost:${GHOST_VERSION}-alpine

# Add the Object Store storage adapter
# We use the main branch of the repository
ADD --chown=node:node https://github.com/CodeForAfrica/ghost-object-store-storage-adapter.git#main content/adapters/storage/object-store

COPY media-inliner /var/lib/ghost/versions/${GHOST_VERSION}/core/server/services/media-inliner/

# Install dependencies for the storage adapter
WORKDIR /var/lib/ghost/content/adapters/storage/object-store
RUN npm install --omit=dev

# Return to the original working directory
WORKDIR /var/lib/ghost
