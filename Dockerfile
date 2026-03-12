ARG GHOST_VERSION=6.21.2
FROM ghost:${GHOST_VERSION}-alpine

# Add the Object Store storage adapter. We use the main branch of the repository.
ADD --chown=node:node https://github.com/CodeForAfrica/ghost-object-store-storage-adapter.git#main content/adapters/storage/object-store

# Add custom nginx configuration file to Ghost WORKDIR.
# See https://dokku.com/docs/networking/proxies/nginx/#customizing-the-nginx-configuration for details.
ADD nginx.conf.sigil /var/lib/ghost

# Install dependencies for the storage adapter.
WORKDIR /var/lib/ghost/content/adapters/storage/object-store
RUN npm install --omit=dev

# Return to the original working directory.
WORKDIR /var/lib/ghost
