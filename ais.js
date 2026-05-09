// api/ais.js — Vercel Serverless Function
// Proxies requests to MarineTraffic AIS API, keeping your API key server-side.
//
// Deploy: push this file to /api/ais.js in your GitHub repo connected to Vercel.
// Set environment variable MT_API_KEY in your Vercel project settings.
//
// Query params forwarded to MarineTraffic:
//   ?mmsi=123456789       — single vessel by MMSI
//   ?timespan=60          — minutes of history (default 60)
//   ?minlat=...&maxlat=...&minlon=...&maxlon=... — bounding box filter

export default async function handler(req, res) {
  // Allow your GitHub Pages frontend (and localhost for dev)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const API_KEY = process.env.MT_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: "MT_API_KEY environment variable not set." });
  }

  // Build MarineTraffic request
  // Docs: https://www.marinetraffic.com/en/ais-api-services/documentation
  const {
    mmsi,
    timespan = "60",
    minlat, maxlat, minlon, maxlon,
    vessel_type,
  } = req.query;

  const params = new URLSearchParams({
    v: "8",
    protocol: "jsono",
    msgtype: "simple",
    timespan,
  });

  if (mmsi)    params.set("mmsi", mmsi);
  if (minlat)  params.set("minlat", minlat);
  if (maxlat)  params.set("maxlat", maxlat);
  if (minlon)  params.set("minlon", minlon);
  if (maxlon)  params.set("maxlon", maxlon);
  if (vessel_type) params.set("vessel_type", vessel_type);

  const url = `https://services.marinetraffic.com/api/exportvessels/${API_KEY}?${params}`;

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ error: text });
    }
    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
