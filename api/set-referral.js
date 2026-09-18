// ============================================================
// /api/set-referral
// ============================================================
// Called once, right after signup, if the person arrived via a
// referral link (signup.html?ref=someusername). This is the ONLY
// way profiles.referred_by ever gets set — it's not in the list of
// columns a client can update directly (see migration_v11), and
// even here, it's a no-op if the value is already set. A database
// trigger (lock_referred_by_trigger) backs this up independently:
// even if this endpoint had a bug, the trigger itself refuses to
// let referred_by change once it's non-null.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Log in first.' });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session.' });
  const userId = userData.user.id;

  const { refUsername } = req.body || {};
  if (!refUsername || typeof refUsername !== 'string') {
    return res.status(400).json({ error: 'refUsername is required.' });
  }

  try {
    const { data: me } = await supabaseAdmin.from('profiles').select('referred_by').eq('id', userId).maybeSingle();
    if (me?.referred_by) {
      // Already attributed — nothing to do, not an error.
      return res.status(200).json({ ok: true, alreadySet: true });
    }

    const { data: referrer } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('username', refUsername.toLowerCase().trim())
      .maybeSingle();

    if (!referrer) {
      return res.status(200).json({ ok: true, note: 'Referral username not found — not attributed.' });
    }
    if (referrer.id === userId) {
      return res.status(200).json({ ok: true, note: "Can't refer yourself." });
    }

    await supabaseAdmin.from('profiles').update({ referred_by: referrer.id }).eq('id', userId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('set-referral error:', err);
    return res.status(500).json({ error: 'Could not record referral.' });
  }
}
