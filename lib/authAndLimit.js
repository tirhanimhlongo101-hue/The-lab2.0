// ============================================================
// /api/_lib/authAndLimit.js
// ============================================================
// Shared by both AI endpoints. Three jobs:
//  1. Prove the request came from a real logged-in user
//  2. Check their PLAN — Free gets no AI access at all, Pro and
//     Studio get different daily caps. This is enforced here,
//     server-side, using their real plan from the database —
//     never trusting anything the client claims about itself.
//  3. Enforce that daily cap so nobody can rack up unlimited spend
//
// Uses the SERVICE ROLE key, which is only ever read here,
// server-side. This file is never sent to the browser.
// ============================================================

import { createClient } from '@supabase/supabase-js';

// Free accounts don't get AI features at all — this is a real,
// enforced product boundary, not just a hidden button.
const DAILY_AI_LIMIT_BY_PLAN = {
  free: 0,
  pro: 10,
  studio: 60,
};

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function authAndCheckLimit(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return { ok: false, status: 401, error: 'Missing Authorization header — log in first.' };
  }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, error: 'Invalid or expired session.' };
  }
  const userId = userData.user.id;

  const { data: profileRow, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();

  if (profileErr || !profileRow) {
    return { ok: false, status: 403, error: 'Could not verify your account.' };
  }

  const plan = profileRow.plan || 'free';
  const limit = DAILY_AI_LIMIT_BY_PLAN[plan] ?? 0;

  if (limit === 0) {
    return { ok: false, status: 403, error: 'AI features are a Pro feature. Upgrade to use the AI website builder.' };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countErr } = await supabaseAdmin
    .from('ai_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since);

  if (countErr) {
    console.error('Rate limit check failed:', countErr);
    return { ok: false, status: 500, error: 'Server error checking usage.' };
  }
  if ((count || 0) >= limit) {
    return { ok: false, status: 429, error: `Daily AI limit reached (${limit}/day on your plan). Try again tomorrow, or upgrade for a higher limit.` };
  }

  const { error: insertErr } = await supabaseAdmin
    .from('ai_usage')
    .insert({ user_id: userId });
  if (insertErr) {
    console.error('Could not record AI usage:', insertErr);
    // Fail open on a transient logging error rather than break the
    // feature entirely — the abuse case (this insert itself failing
    // repeatedly) is much rarer than a brief connection blip.
  }

  return { ok: true, userId, plan, supabaseAdmin };
}
