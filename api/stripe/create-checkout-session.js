// ============================================================
// /api/stripe/create-checkout-session
// ============================================================
// Called from the "Upgrade" button once real Stripe keys exist.
// Requires you to have created two Products+Prices in your Stripe
// Dashboard first (one for Pro, one for Studio) and put their
// price IDs in Vercel's environment variables — see the bottom
// of this file for exactly which ones.
// ============================================================

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Payments are not set up yet.' });
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Log in first.' });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session.' });

  const { plan } = req.body || {};
  const priceId = plan === 'studio' ? process.env.STRIPE_PRICE_ID_STUDIO : process.env.STRIPE_PRICE_ID_PRO;
  if (!priceId) return res.status(400).json({ error: 'Unknown plan or price not configured.' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userData.user.email,
      client_reference_id: userData.user.id,
      metadata: { supabase_user_id: userData.user.id, plan },
      // CRITICAL: metadata on the Checkout Session does NOT carry over to
      // the Subscription object Stripe creates behind it — they're
      // separate objects with separate metadata. Without setting it here
      // too, webhook.js's customer.subscription.deleted/updated handlers
      // would never know whose subscription just ended, and a cancelled
      // subscriber would keep Pro/Studio access forever, silently.
      subscription_data: { metadata: { supabase_user_id: userData.user.id, plan } },
      success_url: `${process.env.PUBLIC_SITE_URL}/dashboard.html?upgraded=1`,
      cancel_url: `${process.env.PUBLIC_SITE_URL}/dashboard.html`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not start checkout.' });
  }
}

// ============================================================
// Environment variables this needs (add in Vercel Settings →
// Environment Variables, same place as your other keys):
//
//   STRIPE_SECRET_KEY        — from Stripe Dashboard → Developers → API keys
//   STRIPE_PRICE_ID_PRO      — the Price ID of your Pro subscription product
//   STRIPE_PRICE_ID_STUDIO   — the Price ID of your Studio subscription product
//   PUBLIC_SITE_URL          — your live site URL, e.g. https://the-lab-iwe2.vercel.app
// ============================================================
