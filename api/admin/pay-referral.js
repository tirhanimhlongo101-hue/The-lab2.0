// ============================================================
// /api/admin/pay-referral
// ============================================================
// Admin-only, same requireAdmin() pattern as every other privileged
// action here. Pays the referrer their referral_commissions.
// amount_cents in FULL — this is not a sale being split, it IS the
// commission, so there's no LAB_COMMISSION_RATE deduction here
// (unlike send-payout.js). Same non-negotiable safety rule as
// send-payout.js: the destination is always whatever the referrer
// themselves connected (their own Stripe/PayPal) — the admin picks
// WHICH pending commission to pay, never WHERE it goes.
// ============================================================

import Stripe from 'stripe';
import { requireAdmin } from '../../lib/requireAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const supabaseAdmin = auth.supabaseAdmin;

  const { commissionId } = req.body || {};
  if (!commissionId) return res.status(400).json({ error: 'commissionId is required.' });

  const { data: commission, error: commissionErr } = await supabaseAdmin
    .from('referral_commissions')
    .select('id, referrer_id, amount_cents, status')
    .eq('id', commissionId)
    .maybeSingle();
  if (commissionErr || !commission) return res.status(404).json({ error: 'Commission not found.' });
  if (commission.status === 'paid') return res.status(400).json({ error: 'This commission was already paid.' });

  const { data: referrer, error: referrerErr } = await supabaseAdmin
    .from('profiles')
    .select('id, username, stripe_connect_account_id, stripe_connect_status, paypal_email')
    .eq('id', commission.referrer_id)
    .maybeSingle();
  if (referrerErr || !referrer) return res.status(404).json({ error: 'Referrer not found.' });

  const hasStripe = referrer.stripe_connect_account_id && referrer.stripe_connect_status === 'active';
  const hasPaypal = !!referrer.paypal_email;
  if (!hasStripe && !hasPaypal) {
    return res.status(400).json({ error: `${referrer.username} hasn't connected a payout method yet.` });
  }

  try {
    let provider, providerId;

    if (hasStripe && process.env.STRIPE_SECRET_KEY) {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const transfer = await stripe.transfers.create({
        amount: commission.amount_cents,
        currency: 'usd',
        destination: referrer.stripe_connect_account_id,
        description: `Referral bonus — ${referrer.username}`,
        metadata: { supabase_user_id: referrer.id, referral_commission_id: commission.id },
      });
      provider = 'stripe';
      providerId = transfer.id;
    } else if (hasPaypal) {
      if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
        return res.status(503).json({ error: 'PayPal payouts are not configured yet.' });
      }
      const base = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
      const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok) throw new Error('PayPal auth failed: ' + JSON.stringify(tokenJson));

      const payoutRes = await fetch(`${base}/v1/payments/payouts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tokenJson.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender_batch_header: { sender_batch_id: `ref-${commission.id}-${Date.now()}`, email_subject: 'Your Lab referral bonus' },
          items: [{
            recipient_type: 'EMAIL',
            amount: { value: (commission.amount_cents / 100).toFixed(2), currency: 'USD' },
            receiver: referrer.paypal_email,
            note: 'Referral bonus from The Lab',
          }],
        }),
      });
      const payoutJson = await payoutRes.json();
      if (!payoutRes.ok) throw new Error('PayPal payout failed: ' + JSON.stringify(payoutJson));
      provider = 'paypal';
      providerId = payoutJson.batch_header?.payout_batch_id;
    }

    await supabaseAdmin
      .from('referral_commissions')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', commission.id);

    await supabaseAdmin.from('payment_events').insert({
      provider, event_type: 'referral_commission_paid', user_id: referrer.id,
      raw_payload: { commissionId: commission.id, amountCents: commission.amount_cents, providerId },
    });

    return res.status(200).json({ ok: true, provider });
  } catch (err) {
    console.error('Referral payout failed:', err);
    return res.status(500).json({ error: 'Payout failed — see server logs for details.' });
  }
}
