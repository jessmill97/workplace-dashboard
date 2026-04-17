// netlify/functions/claude.js
// Proxies requests to the Anthropic API.
// The API key lives in env vars and never reaches the browser.
//
// REQUIRED ENV VAR:
//   ANTHROPIC_API_KEY — from console.anthropic.com

export default async (req, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const body = await req.json();

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: body.max_tokens || 1000,
        system:     body.system,
        messages:   body.messages,
        ...(body.mcp_servers ? { mcp_servers: body.mcp_servers } : {}),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic ${response.status}: ${err}`);
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), { headers });

  } catch (err) {
    console.error("claude.js error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/claude" };
