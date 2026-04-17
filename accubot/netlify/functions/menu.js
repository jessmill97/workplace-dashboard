// netlify/functions/menu.js
//
// DAILY MENU LOGIC:
// - The kitchen posts the full week's menu in Slack #food every Friday
// - Zapier saves the raw message to a Google Sheet (one row per post)
// - This function works out what day it is and asks Claude to extract
//   ONLY that day's dishes from the full weekly message
// - On Friday from 2pm: shows next week's Monday menu as a preview
//
// GOOGLE SHEET FORMAT (two columns):
//   Column A: Date      — date the message was posted, dd/mm/yyyy
//   Column B: Raw Menu  — the full Slack message text
//
// REQUIRED ENV VARS:
//   MENU_SHEET_ID      — Google Sheet ID from the URL
//   ANTHROPIC_API_KEY  — used to extract today's dishes from the raw message

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

    // ── Work out London time and which day's menu to show ─────────
    const londonNow  = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
    const dayOfWeek  = londonNow.getDay();   // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
    const hourLondon = londonNow.getHours(); // 0–23

    // Which day label should we extract from the menu?
    // Friday after 2pm and weekend → show "Monday" (next week preview)
    // All other times → show today's day name
    let targetDay;
    let isPreview = false;

    if ((dayOfWeek === 5 && hourLondon >= 14) || dayOfWeek === 6 || dayOfWeek === 0) {
      targetDay = "Monday";
      isPreview = true;
    } else {
      targetDay = DAY_NAMES[dayOfWeek]; // "Monday", "Tuesday" etc
    }

    // ── Fetch the Google Sheet ─────────────────────────────────────
    const csvUrl  = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
    const csvResp = await fetch(csvUrl);
    if (!csvResp.ok) throw new Error(`Sheet fetch ${csvResp.status}`);
    const csv = await csvResp.text();

    // Parse rows, skip header
    const allRows = csv.trim().split("\n").slice(1).map(row => {
      const cols = [];
      let cur = "", inQ = false;
      for (const ch of row + ",") {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      return cols;
    }).filter(c => c[0] && c[1]); // must have date AND menu text

    if (allRows.length === 0) {
      return new Response(
        JSON.stringify({ items: null, live: false, reason: "sheet_empty" }),
        { headers }
      );
    }

    // On Friday after 2pm / weekend: use the LAST row (this week's post = next week's menu)
    // All other days: use the LAST row too (it's the most recent weekly post)
    const chosenRow   = allRows[allRows.length - 1];
    const rawMenuText = chosenRow[1];

    if (!apiKey) {
      return new Response(
        JSON.stringify({ items: null, live: false, reason: "no_api_key" }),
        { headers }
      );
    }

    // ── Ask Claude to extract just today's dishes ──────────────────
    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: `You extract lunch menu items from a weekly kitchen menu message.
You will be told which day to extract. Return ONLY that day's dishes.

Return ONLY valid JSON, no markdown:
{"items":[{"e":"emoji","name":"item name","tags":["Vegan","GF","Fish","Dairy","Gluten","Halal","Nuts"]}]}

Rules:
- Pick a fitting food emoji for each dish
- Only include dietary tags that actually apply — use [] if none apply
- "Ve" or vegan icon = Vegan tag. "GF" or gluten-free icon = GF tag. Gluten label = Gluten tag.
- Fix obvious typos in dish names (e.g. "vegtable" → "vegetable", "karaage" is correct)
- If the requested day is not found in the message, return ALL dishes with no day filter
- If no food items at all, return {"items":[]}`,
        messages: [{
          role:    "user",
          content: `Extract only the ${targetDay} dishes from this weekly menu message:\n\n${rawMenuText}`,
        }],
      }),
    });

    const claudeData = await claudeResp.json();
    const rawText    = claudeData.content?.[0]?.text || "{}";

    try {
      const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
      if (parsed.items?.length) {
        return new Response(
          JSON.stringify({
            items:     parsed.items,
            live:      true,
            source:    "slack",
            targetDay,
            isPreview, // true = showing next week's Monday as a preview
          }),
          { headers }
        );
      }
    } catch(e) {}

    return new Response(
      JSON.stringify({ items: null, live: false, reason: "parse_failed" }),
      { headers }
    );

  } catch (err) {
    console.error("menu.js error:", err.message);
    return new Response(
      JSON.stringify({ items: null, live: false, error: err.message }),
      { status: 500, headers }
    );
  }
};

export const config = { path: "/api/menu" };
