# ACCUBOT — Accurx Workplace Dashboard

Internal workplace dashboard with live room availability, lunch menu, TfL + weather, and AI chat.

---

## Quick start

```bash
git clone https://github.com/accurx/accubot
cd accubot
npm install -g netlify-cli
netlify dev   # runs locally at localhost:8888
```

---

## Project structure

```
accubot/
├── public/
│   └── index.html              # The entire dashboard (single file)
├── netlify/
│   └── functions/
│       ├── claude.js            # Anthropic API proxy
│       ├── rooms.js             # Google Calendar freebusy → live room status
│       └── menu.js              # Google Sheet → today's lunch menu
├── netlify.toml                 # Build config + redirects
└── README.md
```

---

## Environment variables

Set all of these in **Netlify dashboard → Site settings → Environment variables**.  
Never put these in code.

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | From console.anthropic.com |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ✅ for live rooms | Full JSON key file contents (see below) |
| `GOOGLE_ADMIN_EMAIL` | ✅ for live rooms | An admin email to impersonate (e.g. admin@accurx.com) |
| `MENU_SHEET_ID` | ✅ for live menu | Google Sheet ID from the URL |
| `MENU_RAW_MODE` | Optional | Set to `true` if using raw Slack text mode in Zapier |

---

## Setting up live room availability (IT team)

The rooms function queries Google Calendar's freebusy API using a service account. This gives real-time accurate room status for all 17 rooms.

### Steps

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g. "accubot-prod")
3. Enable the **Google Calendar API**
4. Go to **IAM & Admin → Service Accounts → Create Service Account**
   - Name: `accubot-rooms`
   - No roles needed at project level
5. On the service account, click **Keys → Add Key → JSON** → download the file
6. Click **Edit** on the service account → check **Enable Google Workspace Domain-wide Delegation** → note the Client ID
7. In **Google Workspace Admin Console** (admin.google.com):
   - Security → API Controls → Domain-wide delegation
   - Add new: paste the Client ID, scope: `https://www.googleapis.com/auth/calendar.readonly`
8. Paste the full contents of the downloaded JSON key file into `GOOGLE_SERVICE_ACCOUNT_JSON` in Netlify
9. Set `GOOGLE_ADMIN_EMAIL` to any admin email in the Accurx workspace

The dashboard will show "Live · GCal" in the rooms badge once this is working.

---

## Setting up the lunch menu (Zapier)

### Option A — Structured rows (recommended)

The Zapier zap writes one row per menu item into a Google Sheet.

**Zap steps:**
1. **Trigger**: Slack → New Message Posted to Channel → `#food`
2. **Filter**: Only continue if `{{message.username}}` contains `kitchen` (or whatever the kitchen account is called)
3. **Action**: Code by Zapier (JavaScript) — parse the message into rows:
```javascript
const lines = inputData.text.split('\n').filter(l => l.trim());
const today = new Date().toLocaleDateString('en-GB');
const rows = lines.map(line => ({
  date: today,
  emoji: '🍽️',   // optional: detect from text
  item: line.trim(),
  tags: ''         // optional: detect Vegan/GF/Fish etc from keywords
}));
return { rows: JSON.stringify(rows) };
```
4. **Action**: Google Sheets → Create Spreadsheet Row (loop over rows)
   - Sheet columns: Date | Emoji | Item | Tags

**Sheet format:**
```
Date        | Emoji | Item                          | Tags
17/04/2026  | 🥬    | Braised red cabbage           | Vegan, GF
17/04/2026  | 🐟    | Fish pie                      | Fish, Dairy, Gluten
```

5. Share the sheet publicly (File → Share → Anyone with the link → Viewer)
6. Copy the Sheet ID from the URL and paste into `MENU_SHEET_ID` in Netlify

### Option B — Raw mode (simpler Zapier setup)

If you don't want to parse in Zapier:
1. Zap just writes the raw Slack message text to a single cell in the sheet (column A)
2. Set `MENU_RAW_MODE=true` in Netlify env vars
3. The `menu.js` function passes the raw text to Claude to extract menu items

---

## Making the site private

### Option 1 — Netlify basic auth (simplest, free)

In Netlify dashboard → Site settings → Access control → Basic password protection  
Set a shared username/password. All staff use the same credentials.  
This is fine for an internal tool. Not SSO, but zero friction to set up.

### Option 2 — Netlify Identity with Google SSO (recommended for production)

1. Netlify dashboard → Identity → Enable
2. Settings → External providers → Enable Google
3. Restrict signups to `@accurx.com` domain
4. Staff log in with their Accurx Google account — no shared password needed

### Option 3 — IP allowlisting (if Accurx has a fixed office IP)

Netlify Pro plan: Site settings → Access control → IP-based restrictions  
Only allows access from the office network. Simple but blocks remote working.

---

## Setting as Chrome homepage (IT team)

### Via Google Chrome enterprise policy (recommended)

Create or update a Chrome policy file:

```json
{
  "HomepageLocation": "https://accubot.netlify.app",
  "HomepageIsNewTabPage": false,
  "ShowHomeButton": true,
  "NewTabPageLocation": "https://accubot.netlify.app"
}
```

**On macOS (Jamf/MDM):** push as a managed preference for `com.google.Chrome`  
**On Windows (Group Policy):** Computer Configuration → Administrative Templates → Google Chrome → Homepage  
**On Linux:** place in `/etc/opt/chrome/policies/managed/accubot.json`

This sets the homepage AND the new tab page so it appears both on browser open and new tab.

---

## Daily auto-refresh

The dashboard refreshes automatically every 2 minutes via `setInterval`.  
It also refreshes immediately when the browser tab/window becomes visible  
(via `visibilitychange` event) — so when Chrome opens in the morning, it  
always shows fresh data without needing a manual refresh.

---

## Zapier → live announcements (post-hackathon)

Future: add a Slack command (`/announce`) that posts to a dedicated channel,  
Zapier picks it up, writes to a separate Google Sheet or Supabase table,  
and the dashboard polls that for announcements. This replaces the hardcoded  
`STATIC.announcements` array with live data.

---

## Adding ACCUBOT knowledge (feeding it Notion content)

The more context ACCUBOT has, the better it answers. To expand its knowledge:

1. Open `public/index.html`
2. Find the `getSystemPrompt` function
3. Add new sections following the existing format — paste in key Notion page content, team info, policies etc.
4. The prompt is rebuilt on every ACCUBOT message so changes take effect immediately on the next deploy.

For a more scalable solution, store the knowledge base in a separate JSON file  
or Supabase table and fetch it in `claude.js` before passing to the API.

---

## Deployment

```bash
# One-time: connect to Netlify
netlify init

# Deploy to production
git push origin main   # auto-deploys via Netlify CI

# Manual deploy
netlify deploy --prod
```

The site URL is whatever Netlify assigns (e.g. `accubot.netlify.app`).  
You can set a custom domain in Netlify dashboard → Domain management.
