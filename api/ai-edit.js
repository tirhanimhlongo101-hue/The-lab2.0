// ============================================================
// /api/ai-edit
// ============================================================
// This file did not exist before — editor.html has been calling
// it since it was built, and every request 404'd. Pro/Studio were
// being rate-limited (correctly, via authAndCheckLimit) for a
// feature that had no actual backend behind it at all.
//
// Auth + the daily usage cap are enforced by authAndCheckLimit —
// Free gets 0/day (blocked entirely), Pro 10/day, Studio 60/day,
// checked against the real plan in the database, never trusted
// from the client. This file's only job beyond that is: take the
// already-fully-formed prompt editor.html builds (it already
// includes the current website JSON, the instruction, and the
// schema rules), send it to Claude, and hand back the raw text —
// editor.html itself strips code fences and JSON.parses it.
// ============================================================

import { authAndCheckLimit } from '../lib/authAndLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authAndCheckLimit(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI editing is not configured yet.' });
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'A prompt is required.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', errBody);
      return res.status(502).json({ error: 'AI service error — try again.' });
    }

    const data = await response.json();
    const text = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return res.status(200).json({ text });
  } catch (err) {
    console.error('AI edit error:', err);
    return res.status(500).json({ error: 'Could not reach the AI service.' });
  }
}

// ============================================================
// New environment variable needed: ANTHROPIC_API_KEY
// (console.anthropic.com → API Keys). Costs real money per call —
// this is exactly why the plan/rate-limit check above runs FIRST,
// before this file ever spends a token.
// ============================================================
