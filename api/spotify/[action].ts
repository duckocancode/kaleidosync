import type { VercelRequest, VercelResponse } from "@vercel/node";

const SCOPES = "user-read-currently-playing user-read-playback-state";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function getAction(req: VercelRequest): string {
  const raw = req.query.action;
  return (Array.isArray(raw) ? raw[0] : raw) || "";
}

async function handleAuth(req: VercelRequest, res: VercelResponse) {
  const returnUrl = (req.query.returnUrl as string) || "";
  if (!returnUrl) {
    return res.status(400).send("Missing returnUrl query parameter.");
  }

  let clientId: string;
  let redirectUri: string;
  try {
    clientId = requireEnv("SPOTIFY_CLIENT_ID");
    redirectUri = requireEnv("SPOTIFY_REDIRECT_URI");
  } catch (e) {
    return res.status(500).send(String(e));
  }

  const state = Buffer.from(JSON.stringify({ returnUrl }), "utf8").toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  });

  res.redirect(302, `https://accounts.spotify.com/authorize?${params.toString()}`);
}

async function handleCallback(req: VercelRequest, res: VercelResponse) {
  const err = req.query.error as string | undefined;
  const code = req.query.code as string | undefined;
  const stateB64 = req.query.state as string | undefined;

  let returnUrl = "/";
  try {
    if (stateB64) {
      const parsed = JSON.parse(Buffer.from(stateB64, "base64url").toString("utf8")) as { returnUrl?: string };
      if (parsed.returnUrl) returnUrl = parsed.returnUrl;
    }
  } catch {
    return res.status(400).send("Invalid OAuth state.");
  }

  if (err) {
    try {
      const dest = new URL(returnUrl);
      dest.searchParams.set("spotify_error", err);
      return res.redirect(302, dest.toString());
    } catch {
      return res.status(400).send(`Spotify OAuth error: ${err}`);
    }
  }

  if (!code) {
    return res.status(400).send("Missing authorization code.");
  }

  let clientId: string;
  let clientSecret: string;
  let redirectUri: string;
  try {
    clientId = requireEnv("SPOTIFY_CLIENT_ID");
    clientSecret = requireEnv("SPOTIFY_CLIENT_SECRET");
    redirectUri = requireEnv("SPOTIFY_REDIRECT_URI");
  } catch (e) {
    return res.status(500).send(String(e));
  }

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return res.status(502).send(`Spotify token exchange failed: ${text}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
  };

  const dest = new URL(returnUrl);
  dest.searchParams.set("spotify_access_token", tokens.access_token);
  dest.searchParams.set("spotify_refresh_token", tokens.refresh_token);
  res.redirect(302, dest.toString());
}

async function handleRefresh(req: VercelRequest, res: VercelResponse) {
  let body: { refreshToken?: string };
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const refreshToken = body?.refreshToken;
  if (!refreshToken) {
    return res.status(400).json({ error: "Missing refreshToken" });
  }

  let clientId: string;
  let clientSecret: string;
  try {
    clientId = requireEnv("SPOTIFY_CLIENT_ID");
    clientSecret = requireEnv("SPOTIFY_CLIENT_SECRET");
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return res.status(tokenRes.status).json({ error: text });
  }

  const tokens = (await tokenRes.json()) as { access_token: string };
  return res.json({ access_token: tokens.access_token });
}

type PlayerShape = {
  is_playing: boolean;
  progress_ms: number;
  item: { id: string; type?: string; duration_ms?: number } | null;
};

async function fetchPlaybackState(accessToken: string): Promise<{ player: PlayerShape | null; errorStatus: number | null; errorBody: string | null }> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const market = "from_token";

  const playerRes = await fetch(`https://api.spotify.com/v1/me/player?market=${encodeURIComponent(market)}`, {
    headers,
  });

  if (playerRes.status === 401) {
    return { player: null, errorStatus: 401, errorBody: null };
  }

  if (playerRes.status === 200) {
    const player = (await playerRes.json()) as PlayerShape;
    return { player, errorStatus: null, errorBody: null };
  }

  // No active device / empty playback — try currently-playing (sometimes returns data when /me/player is 204)
  if (playerRes.status === 204) {
    const cpRes = await fetch(
      `https://api.spotify.com/v1/me/player/currently-playing?market=${encodeURIComponent(market)}`,
      { headers },
    );
    if (cpRes.status === 200) {
      const body = (await cpRes.json()) as PlayerShape;
      if (body.item && body.item.type === "track" && body.item.id) {
        return { player: body, errorStatus: null, errorBody: null };
      }
    }
    return { player: null, errorStatus: null, errorBody: null };
  }

  const text = await playerRes.text();
  return { player: null, errorStatus: playerRes.status, errorBody: text };
}

async function handleNowPlaying(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  const accessToken = authHeader.slice("Bearer ".length);

  const { player, errorStatus, errorBody } = await fetchPlaybackState(accessToken);

  if (errorStatus === 401) {
    return res.status(401).json({ error: "Spotify unauthorized" });
  }

  if (errorStatus !== null && errorBody !== null) {
    return res.status(errorStatus).send(errorBody);
  }

  if (!player) {
    return res.status(204).end();
  }

  if (!player.item || player.item.type !== "track" || !player.item.id) {
    return res.status(204).end();
  }

  const progress_ms = player.progress_ms ?? 0;
  const analysisRes = await fetch(`https://api.spotify.com/v1/audio-analysis/${player.item.id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let segments: unknown[] = [];
  let beats: unknown[] = [];
  if (analysisRes.ok) {
    const analysis = (await analysisRes.json()) as { segments?: unknown[]; beats?: unknown[] };
    segments = analysis.segments || [];
    beats = analysis.beats || [];
  }

  return res.json({
    isPlaying: player.is_playing,
    track: {
      timestamp: Date.now() - progress_ms,
      item: player.item,
    },
    audioAnalysis: { segments, beats },
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = getAction(req);

  try {
    if (action === "auth" && req.method === "GET") return await handleAuth(req, res);
    if (action === "callback" && req.method === "GET") return await handleCallback(req, res);
    if (action === "refresh" && req.method === "POST") return await handleRefresh(req, res);
    if (action === "now-playing" && req.method === "GET") return await handleNowPlaying(req, res);
  } catch (e) {
    return res.status(500).send(e instanceof Error ? e.message : String(e));
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).send("Method Not Allowed");
}
