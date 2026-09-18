// ============================================================
// /api/admin/send-payout
// ============================================================
// Admin-only. Sends real money to a creator through whichever
// payout method they've connected. Same security shape as every
// other admin action in this app: requireAdmin() independently
// re-verifies the caller is really an admin server-side before
// anything happens — a spoofed client session cannot trigger a
// payout, same as it can't touch plan/role.
//
// This intentionally does NOT let the admin type in an arbitrary
// destination — it only ever pays out to the address/account the
// CREATOR themselves connected (profiles.stripe_connect_account_id
// or profiles.paypal_email), so a compromised admin panel session
// can misuse "send a payout" but can never redirect where a
// specific creator's money goes.
//
// COMMISSION: The Lab keeps LAB_COMMISSION_RATE (2%) of every
// Lab-processed sale before the rest goes to the creator. Two
// different sale types use this rate:
//   1. Lab partner drops (handled by THIS file) — no live checkout
//      exists for these yet, so an admin enters the gross sale
//      amount here and this file computes/sends the split.
//   2. A creator's own Shop products sold through Lab checkout —
//      handled entirely automatically by Stripe itself at the
//      moment of payment, no admin step at all. See
//      api/stripe/create-shop-checkout.js for that flow.
// A creator's own products sold via an EXTERNAL link (Etsy,
// Shopify, etc.) are untouched by The Lab either way — that money
// never reaches us, so there's nothing to take a cut of.
// ============================================================

import Stripe from 'stripe';
import { requireAdmin } from '../../lib/requireAdmin.js';
import { LAB_COMMISSION_RATE } from '../../lib/commission.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const supabaseAdmin = auth.supabaseAdmin;

  const { creatorId, grossAmountCents, currency, note } = req.body || {};
  if (!creatorId || !grossAmountCents || grossAmountCents <= 0) {
    return res.status(400).json({ error: 'creatorId and a positive grossAmountCents (the full sale amount) are required.' });
  }

  const commissionCents = Math.round(grossAmountCents * LAB_COMMISSION_RATE);
  const amountCents = grossAmountCents - commissionCents; // what the creator actually receives

  const { data: creator, error: creatorErr } = await supabaseAdmin
    .from('profiles')
    .select('id, username, stripe_connect_account_id, stripe_connect_status, paypal_email')
    .eq('id', creatorId)
    .maybeSingle();
  if (creatorErr || !creator) return res.status(404).json({ error: 'Creator not found.' });

  const hasStripe = creator.stripe_connect_account_id && creator.stripe_connect_status === 'active';
  const hasPaypal = !!creator.paypal_email;

  if (!hasStripe && !hasPaypal) {
    return res.status(400).json({ error: `${creator.username} hasn't connected a payout method yet.` });
  }

  // Prefer Stripe when both are connected and configured — it settles
  // straight into a bank account with no separate step. Falls back to
  // PayPal automatically if only PayPal is connected.
  try {
    if (hasStripe && process.env.STRIPE_SECRET_KEY) {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const transfer = await stripe.transfers.create({
        amount: amountCents,
        currency: currency || 'usd',
        destination: creator.stripe_connect_account_id,
        description: note || `Payout to ${creator.username}`,
        metadata: { supabase_user_id: creator.id },
      });
      await supabaseAdmin.from('payment_events').insert({
        provider: 'stripe', event_type: 'admin_payout_sent', user_id: creator.id,
        raw_payload: { transfer, grossAmountCents, commissionCents, amountCents },
      });
      return res.status(200).json({ ok: true, provider: 'stripe', id: transfer.id, grossAmountCents, commissionCents, amountCents });
    }

    if (hasPaypal) {
      if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
        return res.status(503).json({ error: 'PayPal payouts are not configured yet (missing API credentials).' });
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
          sender_batch_header: {
            sender_batch_id: `${creator.id}-${Date.now()}`,
            email_subject: 'You have a payout from The Lab',
          },
          items: [{
            recipient_type: 'EMAIL',
            amount: { value: (amountCents / 100).toFixed(2), currency: currency?.toUpperCase() || 'USD' },
            receiver: creator.paypal_email,
            note: note || 'Payout from The Lab',
          }],
        }),
      });
      const payoutJson = await payoutRes.json();
      if (!payoutRes.ok) throw new Error('PayPal payout failed: ' + JSON.stringify(payoutJson));

      await supabaseAdmin.from('payment_events').insert({
        provider: 'paypal', event_type: 'admin_payout_sent', user_id: creator.id,
        raw_payload: { payoutJson, grossAmountCents, commissionCents, amountCents },
      });
      return res.status(200).json({ ok: true, provider: 'paypal', batchId: payoutJson.batch_header?.payout_batch_id, grossAmountCents, commissionCents, amountCents });
    }
  } catch (err) {
    console.error('Payout failed:', err);
    return res.status(500).json({ error: 'Payout failed — see server logs for details.' });
  }
}

// ============================================================
// Environment variables this needs, beyond the Stripe ones already
// set for billing:
//   PAYPAL_CLIENT_ID       — from developer.paypal.com → your app
//   PAYPAL_CLIENT_SECRET   — same place
//   PAYPAL_ENV             — "sandbox" while testing, "live" when real
// ============================================================
