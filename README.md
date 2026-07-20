# Actual Budget Auto-Sync

![Last Commit](https://img.shields.io/github/last-commit/adambeltz2/actualbudget-sync)
![Docker Pulls](https://img.shields.io/docker/pulls/adambeltz/actualbudget-sync)
![License](https://img.shields.io/github/license/adambeltz2/actualbudget-sync)

A standalone, Dockerized automation tool that automatically syncs bank accounts in Actual Budget and emails you a summary of new transactions.

This service is designed to run independently of your main Actual Budget server. It wakes up on a defined schedule (e.g., 6 AM and Noon daily), triggers the sync, and uses a "Snapshot Comparison" logic to identify exactly what changed.

**Available on both [GitHub Container Registry](https://github.com/adambeltz2/actualbudget-sync/pkgs/container/actualbudget-sync) and [Docker Hub](https://hub.docker.com/r/adambeltz/actualbudget-sync)** — pick whichever registry you prefer, the image is identical.

## Features
* **Automated Syncing:** Triggers `runBankSync()` automatically using standard cron syntax (e.g., `0 6,12 * * *`).
* **Snapshot Comparison:** Fetches current transactions before the sync, waits for the SimpleFIN/bank data to update, and fetches transactions again to find new items.
* **Email Reporting:** Emails a report of the new items via Nodemailer.
* **Log Rotation:** Automatically logs actions and rotates log files daily so you can track performance.
* **Web Dashboard:** Configure everything (no `.env` file editing required) and watch live logs from a browser.
* **Remote-Server Friendly:** Easily connects to self-hosted or remote instances of Actual Budget (like Pikapod) securely over the internet.

## Prerequisites
* Docker and Docker Compose (Docker Desktop includes both)
* An active [Actual Budget](https://actualbudget.com/) instance
* Your Actual Budget **Sync ID** (found in *Settings > Show advanced settings > Sync ID*)
* An App Password or SMTP credentials for your email provider (e.g., Gmail App Password), if you want email reports

## Quick Start (Docker Compose)

You don't need to clone this repo — the image is prebuilt and published to both GHCR and Docker Hub. You just need a `docker-compose.yaml`.

1. **Create a project folder and grab the compose file:**
```bash
   mkdir actualbudget-sync && cd actualbudget-sync
   curl -O https://raw.githubusercontent.com/adambeltz2/actualbudget-sync/main/docker-compose.yaml
```

2. **Start it:**
```bash
   docker compose up -d
```
   This pulls `ghcr.io/adambeltz2/actualbudget-sync:latest` and creates `./data` and `./logs` folders next to your compose file for persistent storage.

   **Prefer Docker Hub instead?** Open `docker-compose.yaml` and change the `image:` line to:
```yaml
   image: adambeltz/actualbudget-sync:latest
```
   Everything else works identically — same tags, same behavior, same volumes.

3. **Open the dashboard:** [http://localhost:3000](http://localhost:3000)

   On first load, fill in:
   * **Actual Budget URL** — your server's address (e.g., `https://your-pikapod.pikapod.net`)
   * **Password** — your Actual Budget password
   * **Sync ID** — from *Settings > Show advanced settings > Sync ID*
   * **Cron schedule** — when to run (defaults to `0 6,12 * * *`, 6 AM & noon)
   * **Email settings** (optional) — SMTP host/port, sender, app password, and recipient, if you want email reports

   Settings are saved to `./data/config.json` on your host, so they persist across container restarts/updates.

## Using Docker Desktop

Docker Desktop's built-in **Images → Pull** feature only searches Docker Hub, so it can't pull directly from GHCR through the GUI — but it *can* pull straight from Docker Hub that way if you'd rather skip the terminal entirely for that step. Either way, once the container exists, everything else is GUI-driven:

1. **Via GHCR:** run the Quick Start steps above once, from a terminal (Docker Desktop's own **Terminal** panel works fine too).
   **Via Docker Hub:** search `adambeltz/actualbudget-sync` in Docker Desktop's **Images → Pull** search bar, or run the Quick Start with the Docker Hub image line swapped in.
2. Once running, the container appears under Docker Desktop's **Containers** tab as `actualbudget-sync`. From there you can start/stop/restart it, view live logs, and jump straight to the dashboard at `localhost:3000` — all without touching the CLI again.
3. To update later: `docker compose pull && docker compose up -d` (or trigger the pull/restart from the Containers tab's **Recreate** option).

## Updating

```bash
docker compose pull
docker compose up -d
```

## Data & Logs

| Path (on host) | Purpose |
|---|---|
| `./data/config.json` | Your saved configuration (URL, Sync ID, schedule, email settings) |
| `./data/` | Actual Budget's local synced data cache |
| `./logs/` | Daily rotated sync logs (kept for 14 days) |

## Notes
* `TIMEZONE` (env var in `docker-compose.yaml`) controls the cron schedule's timezone — defaults to `America/New_York`.
* The container listens on port `3000`; change the left side of the `ports` mapping in `docker-compose.yaml` if that's taken on your host.
* Both registries are updated together on every push to `main`, so tags stay in sync — no need to worry about one being stale relative to the other.
