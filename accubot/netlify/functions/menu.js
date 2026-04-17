// netlify/functions/menu.js
//
// LOGIC:
// - The sheet has one row per week, written by Zapier when the kitchen posts in #food on Friday
// - Before 2pm Friday: show THIS week's menu (current rows)
// - From 2pm Friday onwards: show NEXT week's menu (the new row just posted)
// - Every other day: show the most recent row in the sheet
//   If no row found, fall back to the static demo menu in the dashboard
//
// GOOGLE SHEET FORMAT (two columns, header row + one row per week):
//   Column A: Date      — the Monday of that week, dd/mm/yyyy  e.g. 21/04/2026
//   Column B: Raw Menu  — full text of the Slack message
//
// REQUIRED ENV VARS:
//   MENU_SHEET_ID      — Google Sheet ID from the URL
//   ANTHROPIC_API_KEY  — used to parse raw menu text into structured items

export default async (req, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "s-maxage=300",
  };

  try {
    const sheetId = process.env.MENU_SHEET_ID;
    const apiKey  = process.env.ANTHROPIC_API_KEY;

    if (!sheetId) {
      return new Response(
        JSON.stringify({ items: null, live: false, reason: "not_configured" }),
        { headers }
      );
    }

    // Work out London time
    const londonNow  = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
    const dayOfWeek  = londonNow.getDay();   // 0=Sun, 1=Mon … 5=Fri, 6=Sat
    const hourLondon = londonNow.getHours(); // 0–23

    // Friday at or after 14:00 London time = show next week's menu
    const showNextWeek = (dayOfWeek === 5 && hourLondon >= 14);

    // Fetch the sheet as CSV
    const csvUrl  = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
    const csvResp = await fetch(csvUrl);
    if (!csvResp.ok) throw new Error(`Sheet fetch ${csvResp.status}`);
    const csv = await csvResp.text();

    // Parse all rows, skip header
    const allRows = csv.trim().split("\n").slice(1).map(row => {
      const cols = [];
      let cur = "", inQ = false;
      for (const ch of row + ",") {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      return cols;
    }).filter(c => c[0] && c[1]);

    if (allRows.length === 0) {
      return new Response(JSON.stringify({ items: null, live: false, reason: "sheet_empty" }), { headers });
    }

    // showNextWeek = true  → use the LAST row (most recently posted = next week)
    // showNextWeek = false → use the SECOND-TO-LAST row if it exists, else last row
    let chosenRow;
    if (showNextWeek || allRows.length === 1) {
      chosenRow = allRows[allRows.length - 1];
    } else {
      chosenRow = allRows[allRows.length - 2];
    }

    const rawMenuText = chosenRow[1];
    const rowDate     = chosenRow[0];

    if (!apiKey) {
      return new Response(JSON.stringify({ items: null, live: false, reason: "no_api_key" }), { headers });
    }

    // Ask Claude to parse the raw Slack message into structured menu items
    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: `You extract lunch menu items from a message posted by a kitchen team.
Return ONLY valid JSON, no markdown:
{"items":[{"e":"emoji","name":"item name","tags":["Vegan","GF","Fish","Dairy","Gluten","Halal","Nuts"]}]}
Rules:
- Pick a fitting food emoji for each dish
- Only include dietary tags that actually apply — if nothing special, use []
- Fix obvious typos in dish names
- Ignore day labels like "Monday:" or "Thursday" — just extract the dishes
- If the message lists menus for multiple days, return ALL dishes from ALL days combined
- If no food items found, return {"items":[]}`,
        messages: [{ role: "user", content: `Extract all menu items:\n\n${rawMenuText}` }],
      }),
    });

    const claudeData = await claudeResp.json();
    const rawText    = claudeData.content?.[0]?.text || "{}";

    try {
      const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
      if (parsed.items?.length) {
        return new Response(
          JSON.stringify({ items: parsed.items, live: true, source: "slack", rowDate, nextWeek: showNextWeek }),
          { headers }
        );
      }
    } catch(e) {}

    return new Response(JSON.stringify({ items: null, live: false, reason: "parse_failed" }), { headers });

  } catch (err) {
    console.error("menu.js error:", err.message);
    return new Response(JSON.stringify({ items: null, live: false, error: err.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/menu" };
