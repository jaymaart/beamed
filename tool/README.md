# Discord Mass DM Tool (with Captcha Forwarding)

## What this does
- Logs in tokens from `tokens.txt` and DMs user IDs from `members.txt` in the target server.
- When Discord triggers an hCaptcha, it forwards `{ siteKey, rqdata? }` to your backend `/api/tasks`, so any connected solver at `/captcha-solver` can solve it.

## Prerequisites
- Node.js 18+
- Files in `tool/`:
  - `tokens.txt` — one Discord token per line
  - `serverId.txt` — target server ID (single line)
  - `members.txt` — one user ID per line to DM
- Backend running in repo root (`npm start`) with `ADMIN_PASSWORD` set in `.env` (e.g., `error111`).

## Install
From `tool/`:
```
npm install
```

## Run the backend (repo root)
```
npm install
npm start
```
- Default API base: `http://localhost:8000`

## Run the DM tool (forwarding captchas)
From `tool/`:
```
# Optional: if backend not on localhost:8000
# PowerShell:  $env:API_BASE="http://localhost:8000"
# cmd.exe:     set API_BASE=http://localhost:8000

node dm.js
```

## View/solve captchas
- Solver UI: `http://localhost:8000/captcha-solver` (keep it open; click Refresh if needed).
- Admin UI: `http://localhost:8000/admin` (log in with `ADMIN_PASSWORD`).

## API summary (backend)
- Ingest: `POST /api/tasks` { siteKey, rqdata? }
- Solver report: `POST /api/solve-task`
- Result poll: `GET /api/task-result?taskId=...`
- Admin (session required): `/api/admin/login`, `/api/admin/stats`, `/api/tasks`

## Notes
- Everything is in-memory; restarting the backend clears tasks/workers/sessions.
- The tool does not solve captchas; it only forwards them so the solver can handle them.
# Discord Mass DM Tool (Updated August 2025)

Welcome to the **Discord Mass DM Tool**! This powerful utility is designed for users who need to send discord mass dms or direct messages to multiple members in a Discord server efficiently. Unlike other tools, our solution is unique in its capability to solve captchas automatically, making it the only working mass DM tool on the market with this feature.

## Features

- **Member Scraping**: Automatically scrape the Discord server to gather a list of members for direct messaging.
- **Automated DM Sending**: Send discord dms or direct messages to multiple users simultaneously.
- **Blacklisting Admins**: This will automatically blacklist admins
- **Target Audience**: This will scrape the members from your target / rival / server of your niche which will give you your target audience and hence, your mass dm will be the most effective
- **Friend Dming**: Dm all friends on all of the tokens
- **All servers suppory**: Send messages in all channels in all servers
- **Proxy Support**: This supports proxies, which is essential when dming a lot of people and when solving captchas to not get flagged and lock the tokens.
- **Captcha Solving**: Integrated captcha solving capabilities ensure that your messages are delivered without interruptions.
- **User-Friendly Interface**: Simple setup and easy-to-use commands make the tool accessible for everyone.
- **Open Source**: Review, modify, and contribute to the code as it is fully open-source.

# Purchase Unflagged and Private Version (Updated August 2025)!
![image](https://github.com/user-attachments/assets/941de13f-1fa0-41e5-acd1-96a19c4aa76b)

https://github.com/user-attachments/assets/a02868a7-f760-4dd3-a7e9-412d16a6dd7a

The free version of the tool is patched ie DOES NOT WORK, to purchase the paid version (Mass DM + Joiner + Scraper included), dm me on discord @vedora.org or on telegram @tahagorme and Join my server to purchase: https://t.me/vedorasupport https://slashy.zip




## Installation

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/tahagorme/discord-mass-dm-tool.git

2. **Navigate to the Directory**:
```bash
cd discord-mass-dm-tool
```


3. **Install Dependencies**:
```bash
npm install
```


4. **Configure**: Edit the configuration file and put the tokens in tokens.txt, serverId in serverId.txt, and the list of user ids to dm in members.txt.

## Usage

To use the Discord Mass DM Tool:

1. **Run the script**:
```bash
node dm.js
```


# Contributing

We welcome contributions! If you have suggestions or improvements, please create a pull request or open an issue.

# License

This project is licensed under the MIT License. See the LICENSE file for more details.

# Support

For any issues or questions, please open an issue in this repository or contact me on discord @uutu or telegram @tahagorme
https://discord.gg/acoustic

Thank you for using the Discord Mass DM Tool! Happy messaging!
<meta name="google-site-verification" content="9pTsmZCcOKj1sEbLuqehqZqRXbZM1KlfUoW1RH_NrV8" />

