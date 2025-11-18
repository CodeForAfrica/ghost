ARG GHOST_VERSION=6.7.0
FROM ghost:${GHOST_VERSION}-alpine

# Add the Object Store storage adapter. We use the main branch of the repository.
ADD --chown=node:node https://github.com/CodeForAfrica/ghost-object-store-storage-adapter.git#main content/adapters/storage/object-store
# Copy over the Nginx template.
COPY contrib/dokku/nginx.conf.sigil .

# Install dependencies for the storage adapter.
WORKDIR /var/lib/ghost/content/adapters/storage/object-store
RUN npm install --omit=dev

# Return to the original working directory.
WORKDIR /var/lib/ghost
