// ============================================================
// /api/admin/pay-partner-commission
// ============================================================
// Admin-only, same requireAdmin() pattern as everywhere else. Pays
// the creator's commission_cents for one partner_drop_sales row —
// the sale itself already happened and the money is sitting in the
// platform's own Stripe balance (see create-partner-checkout.js);
// this just sends the creator their cut of it, to whichever payout
// method THEY connected. Same non-negotiable rule as every other
// payout file here: the admin picks WHICH sale to settle, never
// WHERE the money goes.
// ============================================================

import Stripe from 'stripe';
import { requireAdmin } from '../../lib/requireAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const supabaseAdmin = auth.supabaseAdmin;

  const { saleId } = req.body || {};
  if (!saleId) return res.status(400).json({ error: 'saleId is required.' });

  const { data: sale, error: saleErr } = await supabaseAdmin
    .from('partner_drop_sales')
    .select('id, creator_id, commission_cents, status')
    .eq('id', saleId)
    .maybeSingle();
  if (saleErr || !sale) return res.status(404).json({ error: 'Sale not found.' });
  if (sale.status === 'paid') return res.status(400).json({ error: 'This commission was already paid.' });

  const { data: creator, error: creatorErr } = await supabaseAdmin
    .from('profiles')
    .select('id, username, stripe_connect_account_id, stripe_connect_status, paypal_email')
    .eq('id', sale.creator_id)
    .maybeSingle();
  if (creatorErr || !creator) return res.status(404).json({ error: 'Creator not found.' });

  const hasStripe = creator.stripe_connect_account_id && creator.stripe_connect_status === 'active';
  const hasPaypal = !!creator.paypal_email;
  if (!hasStripe && !hasPaypal) {
    return res.status(400).json({ error: `${creator.username} hasn't connected a payout method yet.` });
  }

  try {
    let provider, providerId;

    if (hasStripe && process.env.STRIPE_SECRET_KEY) {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const transfer = await stripe.transfers.create({
        amount: sale.commission_cents,
        currency: 'usd',
        destination: creator.stripe_connect_account_id,
        description: `Partner drop commission — ${creator.username}`,
        metadata: { supabase_user_id: creator.id, partner_drop_sale_id: sale.id },
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
          sender_batch_header: { sender_batch_id: `pd-${sale.id}-${Date.now()}`, email_subject: 'Your Lab partner drop commission' },
          items: [{
            recipient_type: 'EMAIL',
            amount: { value: (sale.commission_cents / 100).toFixed(2), currency: 'USD' },
            receiver: creator.paypal_email,
            note: 'Partner drop commission from The Lab',
          }],
        }),
      });
      const payoutJson = await payoutRes.json();
      if (!payoutRes.ok) throw new Error('PayPal payout failed: ' + JSON.stringify(payoutJson));
      provider = 'paypal';
      providerId = payoutJson.batch_header?.payout_batch_id;
    }

    await supabaseAdmin
      .from('partner_drop_sales')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', sale.id);

    await supabaseAdmin.from('payment_events').insert({
      provider, event_type: 'partner_drop_commission_paid', user_id: creator.id,
      raw_payload: { saleId: sale.id, commissionCents: sale.commission_cents, providerId },
    });

    return res.status(200).json({ ok: true, provider });
  } catch (err) {
    console.error('Partner drop commission payout failed:', err);
    return res.status(500).json({ error: 'Payout failed — see server logs for details.' });
  }
}
