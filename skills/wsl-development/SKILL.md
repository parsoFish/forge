---
name: wsl-development
category: tooling
description: WSL2 development patterns — file system performance, memory management, Docker integration, and cross-OS workflows.
---

## When to Use This Skill

- When working on env-optimiser or any WSL2 development tooling
- When debugging performance issues in WSL2
- When configuring Docker Desktop with WSL2 backend
- When managing memory, disk, and process resources in WSL2

## File System Performance

**Critical rule**: Keep project files on the Linux file system, not NTFS mounts.

| Path | Performance | Use For |
|------|-------------|---------|
| `/home/user/...` | Fast (ext4) | All project code, node_modules, .git |
| `/mnt/c/Users/...` | Slow (9p/NTFS) | Accessing Windows files only when needed |
| `/tmp/` | Fast (tmpfs) | Transient build artifacts, test outputs |

```bash
# BAD: Project on Windows drive
cd /mnt/c/Users/me/projects/myapp
npm install  # 10x slower, inotify broken

# GOOD: Project on Linux fs
cd ~/projects/myapp
npm install  # Native speed, full inotify support
```

## Memory Management

### .wslconfig (Windows-side: %USERPROFILE%\.wslconfig)

```ini
[wsl2]
memory=12GB           # Cap WSL memory (default: 50% of host)
swap=4GB              # Swap space
processors=6          # CPU cores allocated
localhostForwarding=true

[experimental]
autoMemoryReclaim=gradual  # Reclaim unused memory over time
sparseVhd=true             # Auto-compact virtual disk
```

### Monitoring Memory from Inside WSL

```bash
# Available memory
free -h

# Memory pressure (PSI — Pressure Stall Information)
cat /proc/pressure/memory
# "some avg10=5.00" means 5% of time, tasks stalled on memory

# Top memory consumers
ps aux --sort=-%mem | head -20

# Docker's memory usage
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}"
```

### Graceful Degradation Under Memory Pressure

```bash
# Check memory floor before spawning agents
AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
if [ "$AVAIL_MB" -lt 1000 ]; then
  echo "Low memory: ${AVAIL_MB}MB available — reducing concurrency"
fi

# Kill lower-priority processes when memory is critical
# (forge orchestrator does this via resource-monitor.ts)
```

## Docker in WSL2

### Architecture
Docker Desktop uses WSL2 as its backend — containers run inside the WSL VM, not a separate VM.

### Performance Tips

```bash
# Ensure Docker data stays on ext4, not NTFS
docker info | grep "Docker Root Dir"
# Should be: /var/lib/docker (inside WSL)

# Use named volumes, not bind mounts to Windows paths
# BAD:  -v /mnt/c/data:/app/data
# GOOD: -v app-data:/app/data
```

### docker-compose.yml for WSL

```yaml
services:
  app:
    volumes:
      # Named volume for persistent data
      - app-data:/data
      # Linux bind mount (fast)
      - ./src:/app/src
      # NEVER: /mnt/c/... (slow)
    # Fix file permissions
    environment:
      - PUID=1000
      - PGID=1000
```

## Network Considerations

```bash
# WSL2 gets a virtual ethernet adapter — IP changes on restart
ip addr show eth0 | grep inet

# localhost forwarding works for most services
# Windows can access WSL services at localhost:<port>

# For fixed IPs (e.g., Docker containers):
# Use host.docker.internal from inside containers to reach WSL host
```

## Development Workflow

### IDE Integration (VS Code Remote - WSL)

```bash
# Open project in VS Code from WSL terminal
code .

# The VS Code server runs inside WSL — full native performance
# Extensions run server-side, not on Windows
```

### Git Performance in WSL

```bash
# Ensure git uses Linux-native, not Windows git
which git
# Should be: /usr/bin/git (NOT /mnt/c/.../git.exe)

# If slow, check credential helper
git config --global credential.helper
# Use: /usr/bin/git-credential-manager
# NOT: /mnt/c/.../git-credential-manager.exe
```

## Python in WSL (env-optimiser)

```bash
# Use WSL's Python, not Windows Python
which python3
# Should be: /usr/bin/python3

# Virtual environments on Linux fs
python3 -m venv ~/projects/env-optimiser/.venv
source ~/projects/env-optimiser/.venv/bin/activate

# pip cache on Linux fs (not NTFS)
pip config set global.cache-dir ~/.cache/pip
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `npm install` extremely slow | Project on `/mnt/c/` | Move to `~/` |
| File watchers miss changes | inotify limit or NTFS mount | `echo 65536 > /proc/sys/fs/inotify/max_user_watches` |
| Docker eating all memory | No memory cap in `.wslconfig` | Set `memory=12GB` |
| WSL process killed randomly | OOM killer | Reduce concurrency, set memory cap |
| `git status` takes 10+ seconds | Large repo on NTFS or Windows git | Move to Linux fs, use `/usr/bin/git` |
| Port already in use | Windows service on same port | Check with `netstat -ano` in PowerShell |

## Security Notes

- WSL can access all Windows files via `/mnt/c/` — lock down with `automount` options in `/etc/wsl.conf`
- SSH keys should be on Linux fs with `chmod 600`, not on NTFS (permissions are emulated)
- Windows Defender can slow Linux fs operations — add exclusions for `%LOCALAPPDATA%\Packages\*\LocalState\ext4.vhdx`
