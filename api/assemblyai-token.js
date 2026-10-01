// Vercel Serverless Function: api/assemblyai-token.js
// Securely mints a short-lived AssemblyAI Universal-3.5 Pro Streaming WebSocket token
// using the server-side process.env.ASSEMBLYAI_API_KEY without exposing secrets to client browsers.

export default async function handler(req, res) {
  // CORS Headers for client app calls
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const rawEnable = process.env.ENABLE_ASSEMBLYAI ??
                    process.env.ENABLE_ASSEMBLY_AI ??
                    process.env.VITE_ENABLE_ASSEMBLYAI ??
                    'false';

  const isEnabled = ['true', '1', 'yes', 'on'].includes(String(rawEnable).trim().toLowerCase());

  const apiKey = process.env.ASSEMBLYAI_API_KEY ||
                 process.env.ASSEMBLY_AI_API_KEY ||
                 process.env.NG_APP_ASSEMBLYAI_API_KEY ||
                 process.env.VITE_ASSEMBLYAI_API_KEY;

  // Support lightweight status check endpoint (?check=status)
  if (req.query && (req.query.check === 'status' || req.query.action === 'status')) {
    return res.status(200).json({
      enabled: isEnabled,
      hasKey: Boolean(apiKey && apiKey.trim()),
      // Case-sensitive on purpose: only the exact lowercase 'true' enables multi-language voice
      multiLanguage: process.env.MULTI_LANGUAGE_SUPPORT === 'true'
    });
  }

  // Block token minting if AssemblyAI is disabled via Vercel env variable
  if (!isEnabled) {
    return res.status(403).json({
      enabled: false,
      error: 'AssemblyAI API is disabled via ENABLE_ASSEMBLYAI=false in Vercel environment. Free Device Speech is active.'
    });
  }

  if (!apiKey || !apiKey.trim()) {
    return res.status(500).json({
      error: 'ASSEMBLYAI_API_KEY is not set in Vercel Cloud Environment Variables.'
    });
  }

  try {
    // AssemblyAI Streaming v3 temporary token endpoint
    // Rule 6: Authorization header takes raw key (no Bearer)
    // expires_in_seconds: 1-600 (300s = 5 minutes window to establish WebSocket connection)
    const tokenResponse = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=300', {
      method: 'GET',
      headers: {
        'Authorization': apiKey.trim()
      }
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return res.status(tokenResponse.status).json({
        error: `AssemblyAI token creation failed (${tokenResponse.status}): ${errorText}`
      });
    }

    const data = await tokenResponse.json();
    return res.status(200).json({
      token: data.token,
      expires_in_seconds: 300
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.message || 'Unexpected error minting AssemblyAI token'
    });
  }
}
