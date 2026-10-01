// Vercel Serverless Function: api/assemblyai-sync.js
// Proxies a short WAV clip to the AssemblyAI Sync STT endpoint using the server-side
// process.env.ASSEMBLYAI_API_KEY, so the browser never holds the secret.
//
// Gated by MULTI_LANGUAGE_SUPPORT, which must be exactly the lowercase string 'true'.
//
// The client sends the raw WAV as the request body with the transcription config in the
// X-AAI-Config header; multipart assembly happens here.

// The two project notes disagree on the path ('/v1/transcribe' vs '/transcribe'), so try both.
const SYNC_STT_PATHS = [
  'https://sync.assemblyai.com/v1/transcribe',
  'https://sync.assemblyai.com/transcribe',
];

// Vercel's Node runtime only pre-parses recognised content types (JSON, urlencoded), so an
// audio/wav body arrives as a readable stream.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AAI-Config, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST with a WAV body.' });
  }

  // Case-sensitive on purpose: only the exact lowercase 'true' enables multi-language
  if (process.env.MULTI_LANGUAGE_SUPPORT !== 'true') {
    return res.status(403).json({
      multiLanguage: false,
      error: 'Multi-language voice is disabled. Set MULTI_LANGUAGE_SUPPORT=true to enable Sync STT.',
    });
  }

  const rawEnable = process.env.ENABLE_ASSEMBLYAI ??
                    process.env.ENABLE_ASSEMBLY_AI ??
                    process.env.VITE_ENABLE_ASSEMBLYAI ??
                    'false';
  if (!['true', '1', 'yes', 'on'].includes(String(rawEnable).trim().toLowerCase())) {
    return res.status(403).json({
      enabled: false,
      error: 'AssemblyAI API is disabled via ENABLE_ASSEMBLYAI in Vercel environment.',
    });
  }

  const apiKey = process.env.ASSEMBLYAI_API_KEY ||
                 process.env.ASSEMBLY_AI_API_KEY ||
                 process.env.NG_APP_ASSEMBLYAI_API_KEY ||
                 process.env.VITE_ASSEMBLYAI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY is not set in Vercel Cloud Environment Variables.' });
  }

  let audio;
  try {
    audio = await readBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Could not read the audio body.' });
  }
  if (!audio || audio.length === 0) {
    return res.status(400).json({ error: 'Empty audio body.' });
  }

  // Forwarded verbatim so language_codes / keyterms_prompt stay the client's decision
  let clientConfig = {};
  try {
    if (req.headers['x-aai-config']) clientConfig = JSON.parse(req.headers['x-aai-config']);
  } catch (e) {
    return res.status(400).json({ error: 'X-AAI-Config is not valid JSON.' });
  }

  const model = process.env.ASSEMBLYAI_SYNC_MODEL || 'universal-3-5-pro';

  for (let i = 0; i < SYNC_STT_PATHS.length; i++) {
    const form = new FormData();
    form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'command.wav');
    form.append('config', new Blob([JSON.stringify(clientConfig)], { type: 'application/json' }));

    let upstream;
    try {
      upstream = await fetch(SYNC_STT_PATHS[i], {
        method: 'POST',
        headers: { 'Authorization': apiKey.trim(), 'X-AAI-Model': model },
        body: form,
      });
    } catch (e) {
      return res.status(502).json({ error: `Sync STT request failed: ${e?.message || e}` });
    }

    // Only a missing route justifies trying the other spelling; real errors should surface
    if ((upstream.status === 404 || upstream.status === 405) && i < SYNC_STT_PATHS.length - 1) continue;

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    // Pass the body straight through, including RFC 9457 problem-details on failure
    return res.send(text || '{}');
  }

  return res.status(502).json({ error: 'No Sync STT endpoint responded.' });
}
