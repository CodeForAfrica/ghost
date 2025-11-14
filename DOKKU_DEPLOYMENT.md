# Ghost Dokku Deployment Guide

Instructions for deploying Ghost with external database and S3 object storage on Dokku.

## Prerequisites

- Dokku instance set up and running
- SSH access to your Dokku server
- Git installed locally
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
  imageOptimization__srcsets=false
```

### 5. Set up Openresty proxy

Since we're using a Lua script in our Nginx config file, we need to use the Openresty proxy on Dokku. The alternative would be to compile our own Nginx with Lua which isn't worth the effort given there's a working solution available.

To set up and configure Openresty, follow [the instructions on the official Dokku docs](https://dokku.com/docs/networking/proxies/openresty/#switching-to-openresty)

### 6. Deploy to Dokku

```bash
# Add Dokku as a remote
git remote add dokku dokku@your-server-ip:your-ghost-app-name

# Push to deploy
git push dokku main
```

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

If you need to rollback to a previous version:

```bash
# List previous releases
dokku releases:list your-ghost-app-name

# Rollback to a previous release
dokku releases:rollback your-ghost-app-name <release-number>
```
