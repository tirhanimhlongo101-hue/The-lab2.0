// ============================================================
// /api/paypal/set-payout-email
// ============================================================
// PayPal's Payouts API (unlike Stripe Connect) doesn't require the
// recipient to go through an OAuth "connect your account" flow at
// all — you send money to any PayPal email address directly. So
// "connecting PayPal" for a creator is just: they tell us the
// PayPal email they want paid to. No PayPal app, no API keys on
// their end, nothing to contact PayPal about.
//
// This is a thin, validated wrapper around updating profiles —
// technically the creator's own row-level policy already lets them
// write paypal_email directly from the client, but routing it
// through here means we can (a) validate it's a real email shape,
// (b) stamp paypal_connected_at server-side so that timestamp can't
// be spoofed, and (c) log the change to payment_events for an
// admin-visible audit trail (e.g. if a creator's payout suddenly
// changes, you can see exactly when).
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Log in first.' });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session.' });
  const userId = userData.user.id;

  const { paypalEmail } = req.body || {};
  if (!paypalEmail || !EMAIL_RE.test(paypalEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ paypal_email: paypalEmail, paypal_connected_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) throw error;

    await supabaseAdmin.from('payment_events').insert({
      provider: 'paypal',
      event_type: 'payout_email_set',
      user_id: userId,
      raw_payload: { paypal_email: paypalEmail },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Could not save PayPal payout email:', err);
    return res.status(500).json({ error: 'Could not save your PayPal email.' });
  }
}
