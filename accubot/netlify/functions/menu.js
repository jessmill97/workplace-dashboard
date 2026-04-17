// netlify/functions/menu.js
// Reads this week's lunch menu from a Google Sheet.
// The sheet is populated automatically by a Zapier zap:
//   Trigger: New message in Slack #food (filter: posted by kitchen team on Fridays)
//   Action: Formatter → parse menu text → Google Sheets append rows
//
// GOOGLE SHEET FORMAT (one row per menu item):
//   Column A: Date       — dd/mm/yyyy  e.g. 17/04/2026
//   Column B: Emoji      — 🥗
//   Column C: Item name  — Mixed grain salad
//   Column D: Tags       — Vegan, GF   (comma-separated)
//
// REQUIRED ENV VAR:
//   MENU_SHEET_ID — the Google Sheet ID (from the URL)
//   Sheet must be shared publicly as "Anyone with the link can view"
//   No API key needed for public sheets.
//
// ZAPIER ZAP SETUP:
//   1. Trigger: Slack → New Message Posted to Channel → #food
//   2. Filter: Only continue if sender is kitchen bot/team AND day is Friday
//   3. Action: Formatter → Text → Extract patterns OR just pass raw text
//   4. Action: Code by Zapier (JS) → parse menu lines into structured rows
//   5. Action: Google Sheets → Create Spreadsheet Row (one per menu item)
//
// ALTERNATIVE (simpler Zapier):
//   Skip parsing in Zapier — just write the raw message to a single cell.
//   Then in this function, call Claude to parse it into JSON.
//   Set MENU_RAW_MODE=true to use this approach.

export default async (req, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "s-maxage=300", // cache for 5 minutes
  };

  try {
    const sheetId  = process.env.MENU_SHEET_ID;
    const rawMode  = process.env.MENU_RAW_MODE === "true";
    const apiKey   = process.env.ANTHROPIC_API_KEY;

    if (!sheetId) {
      return new Response(JSON.stringify({ items: null, live: false, reason: "not_configured" }), { headers });
    }

    // Fetch the Google Sheet as CSV (works for any publicly shared sheet)
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
    const csvResp = await fetch(csvUrl);
    if (!csvResp.ok) throw new Error(`Sheet fetch ${csvResp.status}`);
    const csv = await csvResp.text();

    if (rawMode && apiKey) {
      // ── RAW MODE: Zapier writes the whole Slack message as one cell ──
      // Pass the raw text to Claude to extract structured menu items
      const rawText = csv.trim().split("\n").slice(-1)[0]; // last row = most recent post

      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 500,
          system: `You extract lunch menu items from a Slack message posted by a kitchen team.
Return ONLY valid JSON, no markdown:
{"items":[{"e":"emoji","name":"item name","tags":["Vegan","GF","Fish","Dairy","Gluten","Halal","Nuts"]}]}
Rules:
- Pick a relevant emoji for each dish
- Tags: only include relevant dietary tags from the list above
- If a dish has no special dietary requirements, use an empty tags array
- Clean up typos in dish names
- If no menu items found, return {"items":[]}`,
          messages: [{ role: "user", content: `Extract menu items from this message:\n\n${rawText}` }],
        }),
      });

      const claudeData = await claudeResp.json();
      const text = claudeData.content?.[0]?.text || "{}";
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
        if (parsed.items?.length) {
          return new Response(JSON.stringify({ items: parsed.items, live: true, source: "slack_raw" }), { headers });
        }
      } catch(e) {}

      return new Response(JSON.stringify({ items: null, live: false, reason: "parse_failed" }), { headers });
    }

    // ── STRUCTURED MODE: Zapier writes one row per item with date/emoji/name/tags ──
    const today = new Date().toLocaleDateString("en-GB"); // "17/04/2026"
    const rows  = csv.trim().split("\n").slice(1); // skip header

    const todayItems = rows
      .map(row => {
        // Handle quoted CSV fields properly
        const cols = [];
        let current = "", inQuotes = false;
        for (const ch of row + ",") {
          if (ch === '"') { inQuotes = !inQuotes; continue; }
          if (ch === "," && !inQuotes) { cols.push(current.trim()); current = ""; continue; }
          current += ch;
        }
        return cols;
      })
      .filter(cols => cols[0] === today && cols[2])
      .map(cols => ({
        e:    cols[1] || "🍽️",
        name: cols[2],
        tags: (cols[3] || "").split(",").map(t => t.trim()).filter(Boolean),
      }));

    if (todayItems.length === 0) {
      return new Response(JSON.stringify({ items: null, live: false, reason: "no_menu_today" }), { headers });
    }

    return new Response(JSON.stringify({ items: todayItems, live: true, source: "sheet" }), { headers });

  } catch (err) {
    console.error("menu.js error:", err);
    return new Response(JSON.stringify({ items: null, live: false, error: err.message }), {
      status: 500, headers,
    });
  }
};

export const config = { path: "/api/menu" };
