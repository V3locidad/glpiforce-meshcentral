# glpiforce — MeshCentral plugin for GLPI Agent

Surface GLPI inventory freshness next to each MeshCentral computer, and force a fresh inventory push from selected machines without leaving MeshCentral.

Built for IT admins who tire of asking "why isn't this PC in GLPI?" — pick the machines, click one button, the GLPI Agent on each pushes a new inventory now.

## Features

- **Multi-select** computers across MeshCentral device groups
- **Live online indicator** (`● green` / `○ red`)
- **GLPI badge per host**: `today` / `3d ago` / `not in GLPI` (matched by hostname, case-insensitive, AD suffix stripped)
- **Stale filter**: tick a checkbox to keep only machines older than N days (configurable)
- **Force inventory**: sends a PowerShell to each selected online host. The script tries `http://localhost:62354/now` first (the GLPI Agent's built-in HTTP endpoint), and falls back to restarting the `GLPI Agent` service.
- **Server-side GLPI API calls** — credentials never leave the MeshCentral server.

## Requirements

- MeshCentral 1.1.0 or later, plugins enabled (`settings.plugins.enabled = true`)
- GLPI 10.x reachable from the MeshCentral host
- GLPI **App-Token** (Setup → General → API → Application Tokens)
- GLPI **User-Token** (your user → Personal token, generated from the user profile page)
- Target machines: Windows with **GLPI Agent** installed (modern agent, not the legacy FusionInventory)

## Installation

1. In MeshCentral, go to **My Server → Plugins**
2. Click **Download Plugin** and paste:
   ```
   https://raw.githubusercontent.com/V3locidad/glpiforce-meshcentral/main/config.json
   ```
3. Install and enable the plugin
4. On the MeshCentral host, create the credentials file:
   ```
   meshcentral-data/plugins/glpiforce/glpi-config.json
   ```
   Contents:
   ```json
   {
     "glpiUrl": "https://glpi.your-lan",
     "appToken": "GLPI_APP_TOKEN",
     "userToken": "GLPI_USER_TOKEN",
     "rejectUnauthorized": true,
     "staleAfterDays": 7
   }
   ```
   Set `rejectUnauthorized` to `false` if your GLPI uses a self-signed HTTPS cert.
5. Restart MeshCentral
6. Reload the UI — a new **GLPI** tab appears on each device page

## Usage

1. Open any device, click the **GLPI** tab
2. The pill at the top shows whether GLPI is reachable (`GLPI OK` or the error)
3. The plugin queries `Computer` from the GLPI API and shows for each MeshCentral host:
   - `today` / `Nd ago` (matched by name, green when fresh, red when older than the stale threshold)
   - `not in GLPI` if no Computer matches the hostname
4. Adjust the stale threshold or tick **Show only stale** to focus on the laggards
5. Tick the machines to act on
6. Click **Force inventory on selected**. A confirmation lists how many online machines will receive the command (offline ones are skipped silently)
7. The plugin sends a PowerShell (as SYSTEM) that asks each agent to push an inventory now. Re-click **Refresh GLPI** after a minute to see the `date_mod` update.

## How it works

| Layer | What it does |
|-------|--------------|
| Browser iframe | Reads MeshCentral's in-memory node list, asks the plugin's server side for the GLPI snapshot, and (on click) sends a PowerShell via MeshCentral's existing `runcommands` channel |
| Plugin server side | Talks to GLPI: `initSession` once, caches the session token 30 min, lists `Computer` paginated via Range headers, computes staleness from `date_mod` |
| PowerShell on each agent | Hits `http://localhost:62354/now` first, falls back to `Restart-Service "GLPI Agent"` if the agent's HTTP endpoint is disabled or the service is dead |

The force action is **fire-and-forget** — MeshCentral plugins on this build cannot reliably capture runcommands replies, so verifying success means re-querying GLPI a minute later. Refresh the panel and the badge should turn green.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `GLPI: initSession failed (401)` | App-Token or User-Token wrong | Re-issue both in GLPI |
| `GLPI: ECONNREFUSED` / `ETIMEDOUT` | MeshCentral host can't reach GLPI | Check DNS/firewall from MC host |
| Everything shows `not in GLPI` | Hostname mismatch (Computer renamed in GLPI, or domain suffix differs) | Verify computers exist in GLPI with their MeshCentral name (without `.domain.tld`) |
| Force runs but `date_mod` does not update | GLPI Agent HTTP not enabled and service restart did not trigger an inventory | Enable `httpd-trust 127.0.0.1` in GLPI Agent conf, or set `tasks=inventory` so the service runs inventory on each start |
| Plugin tab missing | Plugin not enabled, or server not restarted | Toggle the plugin, then restart MeshCentral |

## License

MIT
