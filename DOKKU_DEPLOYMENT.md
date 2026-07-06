# Ghost Dokku Deployment Guide

Instructions for deploying Ghost with external database and S3 object storage on Dokku.

## Prerequisites

- Dokku instance set up and running
- SSH access to your Dokku server
- External database (MySQL) with credentials
- S3-compatible storage (AWS S3, DigitalOcean Spaces, etc.) with credentials

## Setup Instructions

### 1. Create the Dokku App

```bash
# On your Dokku server
dokku apps:create your-ghost-app-name
```

### 2. Configure External Database

Since we're using an external database:

```bash
# Set environment variables for external database
dokku config:set your-ghost-app-name \
  database__client=mysql \
  database__connection__host=your-db-host.com \
  database__connection__user=your-db-user \
  database__connection__password=your-db-password \
  database__connection__database=your-db-name \
  database__connection__port=3306
```

### 3. Configure S3 Object Storage

```bash
# Set S3 configuration environment variables
dokku config:set your-ghost-app-name \
  storage__active=object-store \
  storage__files__adapter=object-store \
  storage__media__adapter=object-store \
  storage__objectStore__endpoint=https://s3.your-provider.com \
  storage__objectStore__accessKey=your-s3-access-key \
  storage__objectStore__secretKey=your-s3-secret-key \
  storage__objectStore__bucket=your-s3-bucket-name \
  storage__objectStore__region=your-s3-region \
  storage__objectStore__useSSL=true \
  storage__objectStore__storagePath=content/media/ \
  storage__objectStore__staticFileURLPrefix=content/media/
```

### 4. Set Additional Ghost Configuration

```bash
# Set Ghost URL and other configurations
dokku config:set your-ghost-app-name \
  url=https://your-domain.com \
  NODE_ENV=production \
  imageOptimization__resize=false \
  imageOptimization__srcsets=false \
  mail__from=noreply@yourdomain.com \
  mail__transport=SMTP \
  mail__options__host=smtp.smtp-provider.com \
  mail__options__port=587 \
  mail__options__secure="true" \
  mail__options__auth__user=smtp-user \
  mail__options__auth__pass=SuperSecureSMTPPassword
```

### 5. Set up Nginx proxy

Since we're using a Lua script in our Nginx config file, we need to install the Lua module. On Ubuntu, this can be done by running:

```bash
sudo apt update && sudo apt install libnginx-mod-http-lua
```

The Lua module should automatically be enabled via symlinking. You can confirm this by checking the contents of `/etc/nginx/modules-enabled/`.

### 6. Lock the origin to Cloudflare (firewall layer)

`nginx.conf.sigil` already rejects any request whose real TCP peer isn't a Cloudflare edge (the `geo $realip_remote_addr $from_cloudflare` block → `403`). Add a host firewall as a second, stronger layer so junk traffic never even reaches Nginx — this stops volumetric floods before they cost you CPU or connection slots.

> [!WARNING]
> **Do not lock yourself out.** Allow SSH (and any other admin ports) *before* enabling ufw or setting a default-deny policy. The snippet below allows port 22 first.

Cloudflare publishes its ranges at <https://www.cloudflare.com/ips-v4> and <https://www.cloudflare.com/ips-v6>, and changes them occasionally, so don't hand-copy them — drive ufw from the live lists with a script.

Create `/usr/local/bin/refresh-cloudflare-ufw.sh` on the Dokku host:

```bash
#!/usr/bin/env bash
# Restrict inbound 80/443 to Cloudflare edge IPs. Idempotent: safe to re-run.
set -euo pipefail

PORTS=(80 443)

# Fetch current Cloudflare ranges (fail closed — never wipe rules on a bad fetch).
v4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
v6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
[ -n "$v4" ] && [ -n "$v6" ] || { echo "empty Cloudflare list, aborting" >&2; exit 1; }

# Make sure we keep SSH before anything else.
ufw allow 22/tcp comment 'ssh'

# Drop any previous Cloudflare rules so removed ranges don't linger.
while ufw status numbered | grep -q 'cloudflare'; do
  n="$(ufw status numbered | grep 'cloudflare' | head -1 | sed -E 's/^\[[ ]*([0-9]+)\].*/\1/')"
  yes | ufw delete "$n"
done

for ip in $v4 $v6; do
  for port in "${PORTS[@]}"; do
    ufw allow proto tcp from "$ip" to any port "$port" comment 'cloudflare'
  done
done

# Deny direct hits to the web ports from everyone else.
for port in "${PORTS[@]}"; do
  ufw deny "$port/tcp" comment 'cloudflare'
done

ufw --force enable
ufw reload
```

Run it, then confirm:

```bash
sudo chmod +x /usr/local/bin/refresh-cloudflare-ufw.sh
sudo /usr/local/bin/refresh-cloudflare-ufw.sh
sudo ufw status verbose
```

Keep it current with a weekly cron job (Cloudflare rarely changes ranges, but this makes it self-healing):

```bash
# /etc/cron.d/refresh-cloudflare-ufw
0 4 * * 1 root /usr/local/bin/refresh-cloudflare-ufw.sh >> /var/log/cloudflare-ufw.log 2>&1
```

> [!NOTE]
> The `allow from <cf-ip>` rules must sit **above** the `deny <port>` rules for ufw to match them first — the script's ordering (allows inserted before the denies are appended) handles this. Verify with `ufw status numbered`. Also keep the `set_real_ip_from` / `geo` lists in `nginx.conf.sigil` in sync with these ranges when Cloudflare updates them; both derive from the same source.

## Deploying to Dokku

It is recommended that you use Docker image deployment on Dokku, as it allows you to use a pre-built Ghost image (like the one defined in this repo).

Before deploying to Dokku, publish the image from GitHub Actions.

**Important:** for a new Ghost upstream version, update `ARG GHOST_VERSION` in `Dockerfile` first and merge that change into `main`. Do not create a release until `Dockerfile` already points at the Ghost version you want to publish. The release workflow validates this and fails if `ghost_version` does not exactly match `ARG GHOST_VERSION`.

1. Open the repository in GitHub.
2. Go to **Actions**.
3. Select **Create Release and Publish Docker Image**.
4. Click **Run workflow**.
5. Fill in the release inputs:
   - `release_kind`: use `upstream` when the release tracks a Ghost upstream version, or `local` when the release only contains local repository changes.
   - `ghost_version`: the Ghost version without the `v` prefix, for example `6.37.0`. This must already match `ARG GHOST_VERSION` in `Dockerfile`.
   - `local_patch`: use `auto` for local releases unless you need a specific `0.0.N` suffix.
   - `target_ref`: usually `main`.
   - `release_notes`: optional notes to add before GitHub's generated release notes. The workflow automatically includes merged PR titles and contributors.
6. Wait for the workflow to create the GitHub release and push the Docker image to Docker Hub.

The workflow uses these tag patterns:

- Upstream release: `ghost_version=6.37.0` creates `v6.37.0`.
- Local release: `ghost_version=6.37.0` with `local_patch=auto` creates the next `v6.37.0-0.0.N` tag.

To deploy using Docker images, run:

```bash
# On the Dokku server
dokku git:from-image your-ghost-app-name registry-account-name/image-name:tag

e.g.
dokku git:from-image pesacheck codeforafrica/pesacheck-ghost:v6.37.0
```

This should pull the specified Ghost image and deploy it as your Dokku app. Make sure to replace `your-ghost-app-name` and `registry-account-name/image-name:tag` with the actual values you want to use. For local releases, use the full local tag, for example `codeforafrica/pesacheck-ghost:v6.37.0-0.0.1`.


## Dokku-Specific Configuration Files

### Using a dokku.json file (for advanced configuration)

If you need to specify Dokku-specific build settings, create a `dokku.json` file in your repository root:

```json
{
  "image": "ghost:6.7.0-alpine",
  "proxy": {
    "web": {
      "port": 2368,
      "scheme": "http"
    }
  }
}
```

## Post-Deployment Steps

### 1. Set up SSL (recommended)

```bash
dokku letsencrypt:enable your-ghost-app-name
```

### 2. Configure Custom Domain

```bash
dokku domains:add your-ghost-app-name your-domain.com
```

### 3. Check Application Status

```bash
dokku ps:report your-ghost-app-name
dokku logs -f your-ghost-app-name
```

## Environment Variables Summary

Your Dokku app will need these environment variables:

### Database Configuration
- `database__client` - Set to `mysql`
- `database__connection__host` - External database host
- `database__connection__user` - Database username
- `database__connection__password` - Database password
- `database__connection__database` - Database name
- `database__connection__port` - Database port (default: 3306 for MySQL)

### S3 Object Storage Configuration
- `storage__active` - Set to `object-store`
- `storage__objectStore__endpoint` - S3 endpoint URL
- `storage__objectStore__accessKey` - S3 access key
- `storage__objectStore__secretKey` - S3 secret key
- `storage__objectStore__bucket` - S3 bucket name
- `storage__objectStore__region` - S3 region
- `storage__objectStore__useSSL` - Enable SSL (true/false)
- `storage__objectStore__storagePath` - set to `content/media/`
- `storage__objectStore__staticFileURLPrefix` - set to `content/media/`

### Ghost Configuration
- `url` - Public URL for your Ghost site
- `NODE_ENV` - Set to `production`
- `imageOptimization__resize` - Set to `false` to disable image resizing
- `imageOptimization__srcsets` - Set to `false` to disable srcsets generation

## Troubleshooting

### Application won't start
- Check logs: `dokku logs your-ghost-app-name`
- Verify all required environment variables are set: `dokku config your-ghost-app-name`
- Ensure your external database is accessible from the Dokku server

### Database connection issues
- Verify database credentials and host are correct
- Check that the database server allows connections from your Dokku server
- Confirm the database exists and has proper permissions

### S3 storage issues
- Ensure S3 credentials have appropriate permissions
- Verify the bucket exists and is accessible
- Check that the endpoint URL is correct

### Health Checks
Ghost will be accessible on port 2368 inside the container. Ensure any firewall rules allow this connection if needed.

## Scaling

Ghost typically runs as a single process, but you can scale horizontally if needed:

```bash
dokku ps:scale your-ghost-app-name web=2
```

Note: For Ghost to work properly with multiple instances, you'll need a shared file system for themes and content, which isn't needed with S3 object storage for media files.

## Rollback

For this app, roll back by deploying the previous Docker image tag explicitly. The GitHub release workflow publishes images using the same tag as the GitHub release, for example `v6.37.0` or `v6.37.0-0.0.1`.

Choose the previous tag from the GitHub releases page or Docker Hub, then run:

```bash
# On the Dokku server
dokku git:from-image your-ghost-app-name codeforafrica/pesacheck-ghost:previous-tag

e.g.
dokku git:from-image pesacheck codeforafrica/pesacheck-ghost:v6.35.0
```

Use the full tag for local releases:

```bash
dokku git:from-image pesacheck codeforafrica/pesacheck-ghost:v6.37.0-0.0.1
```
