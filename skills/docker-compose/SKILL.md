---
name: docker-compose
category: infrastructure
description: Docker Compose patterns for multi-container automation — health checks, networking, volumes, and service orchestration.
---

## When to Use This Skill

- When working on simplarr or any Docker Compose-based automation
- When designing multi-container service architectures
- When debugging container networking, volume, or health check issues
- When writing scripts that manage Docker container lifecycles

## Compose File Patterns

### Health Checks (Critical for Automation)

```yaml
services:
  plex:
    image: plexinc/pms-docker:latest
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:32400/identity"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s  # Plex needs time to initialize
    restart: unless-stopped
```

Always define health checks — `depends_on` with `condition: service_healthy` prevents race conditions.

### Dependency Ordering

```yaml
services:
  sonarr:
    depends_on:
      plex:
        condition: service_healthy
      prowlarr:
        condition: service_healthy
    restart: unless-stopped
```

### Volume Strategy

```yaml
volumes:
  # Named volumes for persistent data
  plex-config:
    driver: local

  # Bind mounts for media (shared across containers)
  media:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/media

services:
  plex:
    volumes:
      - plex-config:/config          # Persistent config
      - media:/data/media:ro          # Read-only media access
      - /tmp/plex-transcode:/transcode  # Ephemeral transcode dir
```

### Environment Variable Patterns

```yaml
services:
  sonarr:
    environment:
      - PUID=${PUID:-1000}
      - PGID=${PGID:-1000}
      - TZ=${TZ:-UTC}
    env_file:
      - .env  # Secrets loaded from gitignored file
```

## Networking

```yaml
# Custom network for inter-service communication
networks:
  media-stack:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16

services:
  plex:
    networks:
      media-stack:
        ipv4_address: 172.20.0.10  # Fixed IP for reliable cross-container refs
    ports:
      - "32400:32400"  # Only expose what's needed externally
```

## Automation Scripts

### Graceful Restart Pattern

```bash
#!/usr/bin/env bash
# Restart a service without losing in-progress operations
service="$1"

# Check if service is processing
if docker compose exec "$service" pgrep -f "download" >/dev/null 2>&1; then
  echo "Service is busy — waiting for current operation..."
  docker compose exec "$service" /app/wait-idle.sh
fi

docker compose restart "$service"
docker compose exec "$service" /app/health-check.sh
```

### Log Monitoring

```bash
# Follow logs with timestamps, filter for errors
docker compose logs -f --timestamps --since 1h 2>&1 | \
  grep -E "(ERROR|WARN|FATAL)" --line-buffered
```

## WSL2 + Docker Considerations

- **File system performance**: Keep Docker data on ext4 (`/var/lib/docker`), not NTFS mounts
- **Memory limits**: Set in `.wslconfig` — Docker shares WSL's allocation
- **Port forwarding**: `localhost` on Windows maps to WSL's Docker ports automatically
- **Bind mounts**: Use Linux paths (`/home/...`), not Windows paths (`/mnt/c/...`) for performance

## Testing Docker Compose Stacks

```bash
# Validate compose file
docker compose config --quiet

# Dry-run: check all images exist
docker compose pull --ignore-buildable

# Integration test: bring up, verify health, tear down
docker compose up -d
docker compose exec plex curl -sf http://localhost:32400/identity
docker compose down -v  # -v removes volumes for clean state
```

## Security Checklist

- [ ] No secrets in compose file (use `.env` or Docker secrets)
- [ ] Containers run as non-root (`PUID`/`PGID` or `user:` directive)
- [ ] Read-only mounts where possible (`:ro`)
- [ ] No `privileged: true` unless absolutely required
- [ ] Network segmentation (don't expose internal services)
- [ ] Image pinning (use specific tags, not `:latest` in production)
