# Ghost Blog with Object Storage

A production-ready Ghost blog platform configured with MinIO object storage for media files, using Docker Compose for container orchestration.

This file covers local development and testing. For deployment to Dokku, see [DOKKU_DEPLOYMENT.md](DOKKU_DEPLOYMENT.md).

## Overview

This project sets up a complete Ghost blogging platform with the following components:

- **Ghost**: Version 6.5.3 - Modern publishing platform
- **MySQL**: Version 8.4.7 - Database for content management
- **MinIO**: S3-compatible object storage for media files
- **Custom Storage Adapter**: Object store adapter for S3-compatible storage

## Prerequisites

- Docker Engine
- Docker Compose
- At least 2GB of RAM available

## Quick Start

1. Clone this repository
2. Copy the sample environment file:
   ```bash
   cp .env.sample .env
   ```
3. Review and customize the environment variables in `.env` as needed
4. Start the services:
   ```bash
   docker compose up
   ```
5. Access Ghost at `http://localhost:8080`
6. Access MinIO Console at `http://localhost:9001`

## Configuration

### Environment Variables

The `.env` file contains configuration for all services:

**MinIO Configuration:**
- `MINIO_ROOT_USER` - MinIO admin username
- `MINIO_ROOT_PASSWORD` - MinIO admin password
- `MINIO_ENDPOINT` - MinIO endpoint URL
- `MINIO_BUCKET_NAME` - Bucket name for media storage
- `MINIO_ACCESS_KEY` - Access key for object storage
- `MINIO_SECRET_KEY` - Secret key for object storage
- `MINIO_REGION` - Region for object storage
- `MINIO_USE_SSL` - SSL usage flag (true/false)

**MySQL Configuration:**
- `MYSQL_HOST` - Database host name
- `MYSQL_ROOT_PASSWORD` - Root password for MySQL
- `MYSQL_DATABASE` - Database name

**Ghost Configuration:**
- `url` - Public URL for the Ghost instance
- Database connection settings
- Image optimization settings
- Object storage adapter settings

### Services

- **Ghost**: Runs on port 8080 (mapped from 2368)
- **MySQL**: Runs on port 13306 (mapped from 3306)
- **MinIO**: Runs on ports 9000 (API) and 9001 (Console)

## Architecture

The system uses a [custom object storage adapter](https://github.com/CodeForAfrica/ghost-object-store-storage-adapter.git) to store media files in MinIO instead of the local filesystem. This setup provides:

- Scalable media storage
- Better separation of concerns
- Easy backup and migration
- S3-compatible storage backend

## Volumes

The following volumes are created for data persistence:
- `ghost` - Ghost content (themes, apps, images)
- `db` - MySQL database data
- `minio_data` - MinIO object storage data

## Development

To build and run the application:

```bash
# Build and start all services
docker compose up --build -d

# View logs
docker compose logs -f

# Stop services
docker compose down

# Stop and remove volumes (data will be lost)
docker compose down -v
```

## Troubleshooting

### Common Issues

1. **Ghost fails to start**: Check that MySQL and MinIO are healthy before Ghost starts
2. **Media upload fails**: Verify MinIO connectivity and bucket permissions
3. **Database connection errors**: Check MySQL health and credentials in `.env`
4. **MinIO not accessible**: Confirm that the initialization container completed successfully

### Health Checks

Each service includes health checks:
- MySQL: Pings the database every 7 seconds
- MinIO: Checks health endpoint every 10 seconds
- Ghost: Starts after both MySQL and MinIO are healthy

### Logs

View service logs with:
```bash
docker compose logs ghost
docker compose logs db
docker compose logs minio
```
