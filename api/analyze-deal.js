// ============================================================
// /api/analyze-deal
// ============================================================
// Replaces the old client-side analyzeTerms() keyword matcher
// (checking for the literal words "unlimited" or "forever") with
// something that actually reads the deal terms — unfair pay for
// the scope of work, one-sided usage rights, exclusivity with no
// time limit, vague deliverables, missing kill fee, and so on —
// and returns a professional counter-message the creator can send
// back asking for better terms, rather than just a list of
// warnings with nowhere to go.
//
// Same plan-gating and rate limit as api/ai-edit.js — this costs
// real money per call, so Free gets zero access and Pro/Studio
// share the same daily cap, enforced server-side.
// ============================================================

import { authAndCheckLimit } from '../lib/authAndLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await authAndCheckLimit(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'The AI deal checker is not configured yet.' });
  }

  const { terms, amount, brandName, platform } = req.body || {};
  if (!terms || typeof terms !== 'string' || terms.trim().length < 10) {
    return res.status(400).json({ error: 'Paste the actual deal terms first — a few words is too little to review.' });
  }

  const prompt = `You are reviewing a brand deal on behalf of a content creator, before they sign. Be direct and specific — this creator needs a real opinion, not vague caution. Return ONLY raw JSON, no markdown, no commentary, matching exactly this shape:

{
  "verdict": "fair" | "caution" | "unfair",
  "flags": [ { "issue": string, "why": string, "severity": "low" | "medium" | "high" } ],
  "suggestedMessage": string
}

Look specifically for: pay that's low for the scope of work described, unlimited or perpetual usage rights, exclusivity with no time limit or no extra pay for it, no kill fee or cancellation terms, vague or uncounted deliverables, ownership/IP grabs beyond what's reasonable for the stated use, unusually long payment terms (net-60+), and anything else a working creator should push back on. If the terms are genuinely fine, say so plainly in "verdict": "fair" and return an empty flags array — do not invent problems to seem thorough.

"suggestedMessage" must be a short, professional, ready-to-send message the creator could paste directly to the brand asking for adjustments to the specific issues found (or, if verdict is "fair", a brief confirmation message accepting the terms as-is). Write it in first person, as the creator, not as advice to them.

Deal details:
Brand: ${brandName || 'Not specified'}
Platform: ${platform || 'Not specified'}
Payment amount mentioned by the creator: ${amount || 'Not specified'}
Terms as provided by the creator:
"""
${terms}
"""`;

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
        max_tokens: 1500,
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
      .join('\n')
      .replace(/```json|```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      console.error('Could not parse AI response as JSON:', text);
      return res.status(502).json({ error: 'Could not read the AI response — try again.' });
    }

    if (!parsed.verdict || !Array.isArray(parsed.flags)) {
      return res.status(502).json({ error: 'Unexpected AI response shape — try again.' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Deal analysis error:', err);
    return res.status(500).json({ error: 'Could not reach the AI service.' });
  }
}
