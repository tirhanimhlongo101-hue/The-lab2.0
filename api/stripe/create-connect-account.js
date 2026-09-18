// ============================================================
// /api/stripe/create-connect-account
// ============================================================
// This is DIFFERENT from create-checkout-session.js. That file
// takes money FROM a creator (their subscription). This file sets
// up a place to send money TO a creator — a Stripe Express
// "connected account" — for partner-product payouts or brand deal
// payments processed through the platform.
//
// The creator never needs to "contact Stripe" or you — clicking
// Connect in their dashboard calls this, which returns a Stripe-
// hosted onboarding URL. They fill in their own bank details
// directly with Stripe; The Lab never sees or stores them.
//
// One-time setup YOU (the platform) need to do first, in your own
// Stripe Dashboard: enable Connect (Dashboard → Connect → Get
// started) and choose "Express" accounts. This is a platform-level
// setting, done once — not something done per creator.
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
  const userId = userData.user.id;

  try {
    const { data: profileRow } = await supabaseAdmin
      .from('profiles')
      .select('stripe_connect_account_id')
      .eq('id', userId)
      .maybeSingle();

    let accountId = profileRow?.stripe_connect_account_id;

    // Only ever create ONE Express account per creator, ever — re-use it
    // on every subsequent "Connect" click (e.g. if they abandoned
    // onboarding partway and are coming back to finish it).
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: userData.user.email,
        metadata: { supabase_user_id: userId },
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      // Server-only write — the client can never set this column itself
      // (see migration_v5, which revokes client UPDATE on it).
      await supabaseAdmin
        .from('profiles')
        .update({ stripe_connect_account_id: accountId, stripe_connect_status: 'pending' })
        .eq('id', userId);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.PUBLIC_SITE_URL}/dashboard.html?connect=refresh`,
      return_url: `${process.env.PUBLIC_SITE_URL}/dashboard.html?connect=return`,
      type: 'account_onboarding',
    });

    return res.status(200).json({ url: accountLink.url });
  } catch (err) {
    console.error('Stripe Connect onboarding error:', err);
    return res.status(500).json({ error: 'Could not start Stripe onboarding.' });
  }
}

// ============================================================
// Uses the same STRIPE_SECRET_KEY and PUBLIC_SITE_URL you already
// set for create-checkout-session.js — no new env vars needed here.
// (connect-webhook.js below needs one more, separate secret.)
// ============================================================
