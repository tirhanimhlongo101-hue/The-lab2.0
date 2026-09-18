// ============================================================
// /api/stripe/webhook
// ============================================================
// Stripe calls this URL directly (not your app) whenever a
// payment or subscription event happens. We verify the request
// really came from Stripe using the signing secret — never trust
// a webhook payload just because it hit this URL, per the same
// principle as everything else in this app: nothing privileged
// happens without independent server-side verification.
//
// Once this is live, set this exact URL in your Stripe Dashboard
// under Developers → Webhooks:
//   https://YOUR-DOMAIN/api/stripe/webhook
// Subscribe it to these events:
//   checkout.session.completed
//   customer.subscription.updated
//   customer.subscription.deleted
// ============================================================

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { LAB_COMMISSION_RATE, PARTNER_DROP_CREATOR_COMMISSION_RATE } from '../../lib/commission.js';

export const config = { api: { bodyParser: false } }; // Stripe needs the raw, unparsed body to verify the signature

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.supabase_user_id;
      const plan = session.metadata?.plan;
      if (userId && ['pro', 'studio'].includes(plan)) {
        await supabaseAdmin.from('profiles').update({ plan, plan_updated_at: new Date().toISOString() }).eq('id', userId);

        // Referral bonus — one-time, $15, only on someone's FIRST ever
        // paid subscription. The unique constraint on referred_id in
        // referral_commissions is the real backstop against paying twice
        // (e.g. if this webhook fires more than once for the same event,
        // or the person cancels and resubscribes later) — this check is
        // just to avoid a noisy duplicate-key error in the common case.
        const { data: referredProfile } = await supabaseAdmin
          .from('profiles')
          .select('referred_by')
          .eq('id', userId)
          .maybeSingle();

        if (referredProfile?.referred_by) {
          const { data: existing } = await supabaseAdmin
            .from('referral_commissions')
            .select('id')
            .eq('referred_id', userId)
            .maybeSingle();
          if (!existing) {
            await supabaseAdmin.from('referral_commissions').insert({
              referrer_id: referredProfile.referred_by,
              referred_id: userId,
              plan,
            });
          }
        }
      }

      // A shop order (creator's own product, paid through Lab checkout) —
      // separate flow from the subscription branch above, distinguished by
      // metadata.type rather than a different endpoint, since Stripe only
      // gives us one webhook URL per account to listen on.
      if (session.metadata?.type === 'shop_order') {
        await supabaseAdmin.from('shop_orders').insert({
          creator_id: session.metadata.creator_id,
          item_id: session.metadata.item_id,
          item_name: session.metadata.item_name,
          kind: session.metadata.kind,
          price_cents: session.amount_total,
          commission_cents: Math.round((session.amount_total || 0) * LAB_COMMISSION_RATE),
          buyer_email: session.customer_details?.email || null,
          shipping_address: session.shipping_details?.address || null,
          delivery_value: session.metadata.kind === 'digital' ? session.metadata.delivery_value : null,
          delivery_type: session.metadata.delivery_type || 'link',
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
        });
      }

      // A Lab partner drop sale (platform's own product) — money already
      // went to the platform's own Stripe balance (no transfer_data was
      // set at checkout, see create-partner-checkout.js). This just
      // records what the creator who showcased it is owed in commission;
      // an admin pays that out separately via pay-partner-commission.js.
      if (session.metadata?.type === 'partner_drop_order') {
        await supabaseAdmin.from('partner_drop_sales').insert({
          product_id: session.metadata.product_id,
          creator_id: session.metadata.creator_id,
          price_cents: session.amount_total,
          commission_cents: Math.round((session.amount_total || 0) * PARTNER_DROP_CREATOR_COMMISSION_RATE),
          buyer_email: session.customer_details?.email || null,
          stripe_checkout_session_id: session.id,
        });
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      // Subscription ended — drop back to free. Requires the subscription
      // to have supabase_user_id in its metadata, which the checkout
      // session above should have carried over automatically.
      const sub = event.data.object;
      const userId = sub.metadata?.supabase_user_id;
      if (userId) {
        await supabaseAdmin.from('profiles').update({ plan: 'free', plan_updated_at: new Date().toISOString() }).eq('id', userId);
      }
    }

    if (event.type === 'customer.subscription.updated') {
      // Covers everything that can happen OUTSIDE this app's own checkout
      // flow — a failed renewal payment, someone changing plans from
      // Stripe's own customer billing portal, a subscription pausing, etc.
      // Without this, only cancel-to-zero was ever caught; a lapsed-but-
      // not-yet-cancelled subscription would silently keep paid access.
      const sub = event.data.object;
      const userId = sub.metadata?.supabase_user_id;
      if (userId) {
        const activeStatuses = ['active', 'trialing'];
        if (!activeStatuses.includes(sub.status)) {
          // past_due, unpaid, incomplete_expired, paused, etc. — don't
          // wait for a full cancellation to pull paid features back.
          await supabaseAdmin.from('profiles').update({ plan: 'free', plan_updated_at: new Date().toISOString() }).eq('id', userId);
        } else {
          // Still active — but did the PLAN itself change (e.g. someone
          // switched Pro -> Studio from Stripe's own portal, bypassing
          // this app entirely)? Map the current price back to a plan.
          const currentPriceId = sub.items?.data?.[0]?.price?.id;
          let newPlan = null;
          if (currentPriceId === process.env.STRIPE_PRICE_ID_STUDIO) newPlan = 'studio';
          else if (currentPriceId === process.env.STRIPE_PRICE_ID_PRO) newPlan = 'pro';
          if (newPlan) {
            await supabaseAdmin.from('profiles').update({ plan: newPlan, plan_updated_at: new Date().toISOString() }).eq('id', userId);
          }
        }
      }
    }

    // Always log the raw event for a real audit trail, regardless of type
    await supabaseAdmin.from('payment_events').insert({
      provider: 'stripe',
      event_type: event.type,
      user_id: event.data.object?.metadata?.supabase_user_id || null,
      raw_payload: event,
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Error processing Stripe webhook:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// Additional environment variable needed beyond the checkout ones:
//   STRIPE_WEBHOOK_SECRET — from Stripe Dashboard → Developers →
//   Webhooks → your endpoint → "Signing secret" (starts with whsec_)
// ============================================================
