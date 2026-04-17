// netlify/functions/rooms.js
// Fetches live room availability from Google Calendar using a service account.
//
// REQUIRED ENV VARS (set in Netlify dashboard → Site settings → Environment variables):
//   GOOGLE_SERVICE_ACCOUNT_JSON  — full JSON contents of the service account key file
//   GOOGLE_ADMIN_EMAIL           — an admin email to impersonate (domain-wide delegation)
//
// HOW TO SET UP (IT team):
//   1. Go to console.cloud.google.com → create a project
//   2. Enable the Google Calendar API
//   3. Create a Service Account → create a JSON key → download it
//   4. Enable domain-wide delegation on the service account
//   5. In Google Workspace Admin → Security → API controls → Domain-wide delegation
//      → add the service account client ID with scope:
//      https://www.googleapis.com/auth/calendar.readonly
//   6. Paste the full JSON key file contents into GOOGLE_SERVICE_ACCOUNT_JSON env var

const ROOM_CALENDARS = [
  {name:"Barry",       seats:7,  floor:"Ground", calId:"c_188250ov9hnmggc7mdb77sag677lu@resource.calendar.google.com"},
  {name:"Bevan",       seats:5,  floor:"Ground", calId:"c_1883hu3sl1q5qi27iqd93n91duqme@resource.calendar.google.com"},
  {name:"Blackwell",   seats:5,  floor:"Ground", calId:"c_18850hinng97qgt4kaaq6fu58hk2e@resource.calendar.google.com"},
  {name:"Caldicott",   seats:7,  floor:"Ground", calId:"c_1882s8m0eoqegidchj2p8gt5ee7sc@resource.calendar.google.com"},
  {name:"Crumpler",    seats:4,  floor:"Ground", calId:"c_1881l2ehcdqjeinmgumt0vpen207g@resource.calendar.google.com"},
  {name:"Garrett",     seats:8,  floor:"Ground", calId:"c_1884dhoqt4ncki3okufps4qk4uci8@resource.calendar.google.com"},
  {name:"Gawande",     seats:10, floor:"Ground", calId:"c_1882b83uoncgsjg6m4t0at105nlgk@resource.calendar.google.com"},
  {name:"Hopper",      seats:4,  floor:"Ground", calId:"c_188b1e4usjsd4g22mguuq0i3lgbpa@resource.calendar.google.com"},
  {name:"Horton",      seats:16, floor:"Ground", calId:"c_188bmm59l53uujtrg9ksfna2q2vik@resource.calendar.google.com"},
  {name:"Jex-Blake",   seats:5,  floor:"Ground", calId:"c_1889a4cqbac6uj08k5iaidc0r8sv0@resource.calendar.google.com"},
  {name:"Laennec",     seats:5,  floor:"Ground", calId:"c_188cd7tg50juginlnos75aulkk246@resource.calendar.google.com"},
  {name:"Lovelace",    seats:8,  floor:"Ground", calId:"c_188c40gn9llukihhn8qv07k7mq1po@resource.calendar.google.com"},
  {name:"Marmot",      seats:8,  floor:"Ground", calId:"c_188329j623boein3g6n0h0f95sp6c@resource.calendar.google.com"},
  {name:"Nightingale", seats:3,  floor:"Ground", calId:"c_1886pepv092ikj8hivfavi97o8c9u@resource.calendar.google.com"},
  {name:"Papanicolau", seats:7,  floor:"First",  calId:"c_18806n88gqfhmiq2gfkh5892qm65g@resource.calendar.google.com"},
  {name:"Perl",        seats:6,  floor:"First",  calId:"c_1889dp9b9ta5sh65gnjep9laou9h2@resource.calendar.google.com"},
  {name:"Seacole",     seats:16, floor:"First",  calId:"c_188dr5h65lf0qhrjl7c4rcs18r33i@resource.calendar.google.com"},
];

// ── JWT helper — signs a Google service account JWT without any SDK ──
async function getAccessToken(serviceAccountJson, adminEmail) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const header  = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss:   sa.client_email,
    sub:   adminEmail, // impersonate this user for domain-wide delegation
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  };

  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Import the private key
  const pemKey = sa.private_key.replace(/-----.*?-----/g,"").replace(/\s/g,"");
  const keyData = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyData.buffer,
    { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" },
    false, ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");

  const jwt = `${signingInput}.${sigB64}`;

  // Exchange JWT for access token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error(`Token error: ${JSON.stringify(tokenData)}`);
  return tokenData.access_token;
}

export default async (req, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const saJson  = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;

    if (!saJson || !adminEmail) {
      // Return static fallback if not configured yet — dashboard degrades gracefully
      return new Response(JSON.stringify({ rooms: null, live: false, reason: "not_configured" }), { headers });
    }

    const accessToken = await getAccessToken(saJson, adminEmail);

    // Query freebusy for all rooms from now until end of day
    const timeMin = new Date().toISOString();
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 0);
    const timeMax = endOfDay.toISOString();

    const freebusyResp = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        timeZone: "Europe/London",
        items: ROOM_CALENDARS.map(r => ({ id: r.calId })),
      }),
    });

    if (!freebusyResp.ok) throw new Error(`FreeBusy ${freebusyResp.status}`);
    const freebusyData = await freebusyResp.json();

    const nowMs = Date.now();

    const rooms = ROOM_CALENDARS.map(room => {
      const calData = freebusyData.calendars?.[room.calId];
      const busySlots = calData?.busy || [];

      // Find if there's a current or upcoming busy slot
      const currentSlot = busySlots.find(slot => {
        const start = new Date(slot.start).getTime();
        const end   = new Date(slot.end).getTime();
        return start <= nowMs && end > nowMs;
      });

      // Find next slot starting in the future
      const nextSlot = busySlots
        .filter(slot => new Date(slot.start).getTime() > nowMs)
        .sort((a,b) => new Date(a.start) - new Date(b.start))[0];

      if (currentSlot) {
        const until = new Date(currentSlot.end).toLocaleTimeString("en-GB", {
          hour: "2-digit", minute: "2-digit", timeZone: "Europe/London"
        });
        return { ...room, free: false, until, next: nextSlot ? new Date(nextSlot.start).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/London"}) : null };
      }

      return {
        ...room,
        free: true,
        until: null,
        freeUntil: nextSlot
          ? new Date(nextSlot.start).toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", timeZone:"Europe/London" })
          : "End of day",
      };
    });

    return new Response(JSON.stringify({ rooms, live: true }), { headers });

  } catch (err) {
    console.error("rooms.js error:", err);
    return new Response(JSON.stringify({ rooms: null, live: false, error: err.message }), {
      status: 500, headers,
    });
  }
};

export const config = { path: "/api/rooms" };
