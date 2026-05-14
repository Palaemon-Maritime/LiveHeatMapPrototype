// api/ais.js — Vercel Serverless Function with KV caching
//
// SETUP:
//   1. Push to /api/ais.js in your GitHub repo connected to Vercel.
//   2. In Vercel project settings → Environment Variables, add:
//        MT_API_KEY = your 40-character hex MarineTraffic API key
//   3. Enable Vercel KV:
//        Vercel dashboard → your project → Storage tab → Create KV database
//        → Connect to project (auto-adds KV_REST_API_URL + KV_REST_API_TOKEN env vars)
//
// HOW CACHING WORKS:
//   - First client to refresh fetches live data from MarineTraffic and stores it in KV
//   - All subsequent clients within the TTL window get the cached response instantly
//   - No extra MarineTraffic API calls until the cache expires
//   - Cache TTL is set per request via ?ttl=900 (seconds). Default: 15 minutes.
//
// QUERY PARAMS:
//   ?timespan=60       — minutes to look back (default 60, max 1440)
//   ?mmsi=123,456      — comma-separated MMSI numbers for fleet filtering
//   ?limit=2000        — vessels per page (1000–5000, default 2000)
//   ?ttl=900           — cache lifetime in seconds (default 900 = 15 min)
//   ?bust=1            — force a fresh fetch, bypassing the cache (admin use)

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const API_KEY = process.env.MT_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({
      error: "MT_API_KEY not set. Add it in Vercel → Project Settings → Environment Variables.",
    });
  }

  if (!/^[0-9a-f]{40}$/i.test(API_KEY)) {
    return res.status(500).json({
      error: "MT_API_KEY appears malformed. Should be a 40-character hex string.",
    });
  }

  const {
    timespan = "60",
    mmsi,
    limit    = "2000",
    ttl      = "900",   // default cache TTL: 15 minutes
    bust,
  } = req.query;

  // ─── Build a cache key from the query params that affect the result ───
  // Different timespan or MMSI list = different cache entry
  const cacheKey = `ais:${timespan}:${mmsi || "all"}:${limit}`;
  const cacheTTL = Math.min(Math.max(parseInt(ttl) || 900, 60), 3600); // clamp 60s–1hr

  // ─── Check cache first (unless bust=1) ───────────────────────────────
  if (!bust) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader("X-Cache-TTL", cacheTTL);
        return res.status(200).json(cached);
      }
    } catch (kvErr) {
      // KV unavailable — fall through to live fetch, don't fail the request
      console.warn("KV cache read failed, falling through to live fetch:", kvErr.message);
    }
  }

  // ─── Cache miss — fetch from MarineTraffic ───────────────────────────
  const params = new URLSearchParams({
    v:        "9",
    protocol: "jsono",
    timespan,
    limit,
  });

  if (mmsi) params.set("mmsi", mmsi);

  const url = `https://services.marinetraffic.com/api/exportvessels/${API_KEY}?${params}`;

  try {
    const upstream = await fetch(url, {
      headers: { "Accept": "application/json" },
    });

    if (upstream.status === 429) {
      return res.status(429).json({
        error: "MarineTraffic rate limit reached. Check your contract for allowed calls/minute.",
        retryAfter: upstream.headers.get("Retry-After") || "60",
      });
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({
        error: `MarineTraffic returned ${upstream.status}`,
        detail: text,
      });
    }

    const data = await upstream.json();

    // ─── Store in KV cache ──────────────────────────────────────────────
    try {
      await kv.set(cacheKey, data, { ex: cacheTTL });
    } catch (kvErr) {
      // Cache write failed — not fatal, next request will just hit MT again
      console.warn("KV cache write failed:", kvErr.message);
    }

    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Cache-TTL", cacheTTL);
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
