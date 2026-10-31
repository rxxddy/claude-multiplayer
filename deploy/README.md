# Hosting a Claude Multiplayer server

The server is one file (`api.php`) + an SQLite database that it creates itself in `../private_cyberdeck/`
(one level ABOVE the folder that holds api.php, i.e. outside the web root).

Requirements: PHP 8.1+ with `pdo_sqlite`, `sodium`, `mbstring`, `curl`; HTTPS.

Configuration (top of `api.php`, or environment variables which win):

| constant      | env                | meaning                                                              |
|---------------|--------------------|----------------------------------------------------------------------|
| `SERVER_NAME` | `DECK_SERVER_NAME` | community name shown in the app                                      |
| `JOIN_KEY`    | `DECK_JOIN_KEY`    | secret needed to register; empty = anyone with the address can join  |
| `SETUP_TOKEN` | `DECK_SETUP_TOKEN` | protects the FIRST registration (= owner). Always set it on a public server |

The app shows an "Owner setup token" field while the server has no owner. Register yourself first.

---

## A. Oracle Cloud Always Free (public server)

1. Sign up at oracle.com/cloud/free. Home region: **Italy Northwest (Milan)** or **Germany Central (Frankfurt)**
   (data stays in the EU; the home region cannot be changed later). Do NOT upgrade to Pay As You Go.
2. Compute → Instances → Create instance
   - Image: **Canonical Ubuntu 24.04**
   - Shape: **VM.Standard.A1.Flex** (Ampere, 1 OCPU / 6 GB is plenty) — must show "Always Free-eligible".
     If A1 capacity is unavailable, use **VM.Standard.E2.1.Micro**.
   - Networking: create a new VCN + public subnet, "Assign a public IPv4 address" = yes.
   - SSH keys: "Generate a key pair for me" → download BOTH keys and keep them safe.
3. Open ports 80/443 in the cloud firewall: Instance → Subnet → Security List → Add Ingress Rules:
   source `0.0.0.0/0`, TCP, destination port `80`; same for `443`.
4. From your PC (PowerShell), copy the files and run the setup:
   ```
   scp -i <private-key> api.php deploy/oracle-setup.sh ubuntu@<public-ip>:~/
   ssh -i <private-key> ubuntu@<public-ip>
   sudo bash oracle-setup.sh "" "My Community" "my-join-key"
   ```
   First argument = your domain (A-record → public IP); empty = free `<ip>.sslip.io` address with HTTPS.
5. The script prints the address and the **setup token**. In the app: add server → register → paste the
   setup token → you are the owner. Change name / join key later in the app (Server settings).

Updating the server: copy the new `api.php` and run the script again (database is kept).

Backups: every night to `/var/backups/multiplayer/` (14 days). Copy them off the VM from time to time:
`scp -i <key> ubuntu@<ip>:/var/backups/multiplayer/* .`  — the DB plus `deck_secret.key` is all you need
to restore on a new VM (put both into `/var/www/multiplayer/private_cyberdeck/`, owner `www-data`).

Notes:
- Oracle may reclaim an Always Free VM that stays almost idle (CPU, network and memory < 20%) for 7 days.
  Keep the backups; recreating the server takes ~10 minutes with this script.
- @claude bot: an Anthropic API key set in Server settings is billed to its owner for every member's
  question. On a public server keep the bot quotas low or leave the key empty.

## B. Plesk (work server)

1. Websites & Domains → the domain (or a subdomain like `multiplayer.example.it`) → PHP settings:
   PHP **8.3**, FPM. Make sure `pdo_sqlite`, `sodium`, `mbstring`, `curl` are enabled (PHP extensions).
2. SSL/TLS → Let's Encrypt → issue a certificate, enable "Redirect from HTTP to HTTPS".
3. Edit the three constants at the top of `api.php` (name, join key, setup token) and upload it to
   `httpdocs/` with the File Manager. The database is created in `<domain root>/private_cyberdeck/`,
   next to `httpdocs` — not reachable from the web.
4. In the app add `https://multiplayer.example.it` (the app appends `/api.php`), register with the setup
   token. Done.
5. Backups: the Plesk backup of the subscription includes `private_cyberdeck/`.
