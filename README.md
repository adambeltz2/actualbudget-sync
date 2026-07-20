# Actual Budget Auto-Sync

A standalone, Dockerized automation tool that automatically syncs bank accounts in Actual Budget and emails you a summary of new transactions. 

This service is designed to run independently of your main Actual Budget server. It wakes up on a defined schedule (e.g., 6 AM and Noon daily), triggers the sync, and uses a "Snapshot Comparison" logic to identify exactly what changed. 

## Features
* **Automated Syncing:** Triggers `runBankSync()` automatically using standard cron syntax (e.g., `0 6,12 * * *`).
* **Snapshot Comparison:** Fetches current transactions before the sync, waits for the SimpleFIN/bank data to update, and fetches transactions again to find new items using `lodash`.
* **Email Reporting:** Emails a report of the new items via Nodemailer.
* **Log Rotation:** Automatically logs actions and rotates log files daily so you can track performance.
* **Remote-Server Friendly:** Easily connects to self-hosted or remote instances of Actual Budget (like Pikapod) securely over the internet.

## Prerequisites
* Docker and Docker Compose
* An active [Actual Budget](https://actualbudget.com/) instance 
* Your Actual Budget **Sync ID** (Found in *Settings > Show advanced settings > Sync ID*)
* An App Password or SMTP credentials for your email provider (e.g., Gmail App Password)

## Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/adambeltz2/actualbudget-sync.git](https://github.com/adambeltz2/actualbudget-sync.git)
   cd actualbudget-sync
