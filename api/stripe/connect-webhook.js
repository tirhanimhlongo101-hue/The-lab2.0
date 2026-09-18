// ============================================================
// /api/stripe/connect-webhook
// ============================================================
// A SEPARATE endpoint from /api/stripe/webhook. That one listens
// for subscription/billing events on YOUR account. This one
// listens for account.updated events on CREATORS' connected
// Express accounts, which is how we find out their onboarding is
// actually complete and Stripe has verified them enough to receive
// transfers — never trust "they clicked through the flow" as proof
// by itself; Stripe tells us the real status here.
//
// In Stripe Dashboard → Developers → Webhooks, add a SECOND
// endpoint for this file's URL, and when creating it choose
// "Listen to events on Connected accounts" (not your own account).
// Subscribe it to: account.updated
// ============================================================

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe Connect is not configured yet.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe Connect signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (event.type === 'account.updated') {
      const account = event.data.object;
      const userId = account.metadata?.supabase_user_id;

      if (userId) {
        // Stripe's own definition of "ready to be paid": charges_enabled
        // isn't required for a payout-only Express account, but payouts
        // being enabled AND details_submitted being true together is the
        // real signal this account can actually receive a transfer.
        let status = 'pending';
        if (account.payouts_enabled && account.details_submitted) status = 'active';
        else if (account.requirements?.disabled_reason) status = 'restricted';

        await supabaseAdmin
          .from('profiles')
          .update({ stripe_connect_status: status })
          .eq('id', userId);
      }

      await supabaseAdmin.from('payment_events').insert({
        provider: 'stripe',
        event_type: event.type,
        user_id: userId || null,
        raw_payload: event,
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Error processing Stripe Connect webhook:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// New environment variable needed:
//   STRIPE_CONNECT_WEBHOOK_SECRET — the signing secret for the
//   SECOND webhook endpoint (the "connected accounts" one), from
//   Stripe Dashboard → Developers → Webhooks → that endpoint →
//   "Signing secret". This is DIFFERENT from STRIPE_WEBHOOK_SECRET.
// ============================================================
