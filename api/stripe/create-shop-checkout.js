// ============================================================
// /api/stripe/create-shop-checkout
// ============================================================
// Public — anyone visiting a portfolio page can buy, no Lab
// account required. Looks up the item straight from the
// creator's own profiles.shop_picks (never trusts a price or
// name sent from the browser — someone editing devtools cannot
// change what they're charged).
//
// The money split happens INSIDE Stripe at the moment of payment
// (application_fee_amount + transfer_data.destination on the
// PaymentIntent) — 98% lands directly in the creator's connected
// account, 2% stays with The Lab. No admin step, no delay, and
// nobody can misconfigure the split after the fact because it's
// set once, here, from LAB_COMMISSION_RATE — the same constant
// used in /api/admin/send-payout.js.
// ============================================================

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { LAB_COMMISSION_RATE } from '../../lib/commission.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Payments are not set up yet.' });
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const { creatorId, itemId } = req.body || {};
  if (!creatorId || !itemId) return res.status(400).json({ error: 'creatorId and itemId are required.' });

  try {
    const { data: creator, error } = await supabaseAdmin
      .from('profiles')
      .select('id, username, shop_picks, stripe_connect_account_id, stripe_connect_status')
      .eq('id', creatorId)
      .maybeSingle();
    if (error || !creator) return res.status(404).json({ error: 'Creator not found.' });

    const item = (creator.shop_picks || []).find(p => p.id === itemId);
    if (!item) return res.status(404).json({ error: 'Product not found.' });
    if (!item.sellOnLab) return res.status(400).json({ error: 'This product is not set up for Lab checkout.' });
    if (!item.priceCents || item.priceCents <= 0) return res.status(400).json({ error: 'This product has no valid price set.' });
    if (creator.stripe_connect_status !== 'active' || !creator.stripe_connect_account_id) {
      return res.status(400).json({ error: `${creator.username} hasn't finished connecting Stripe yet — checkout isn't available for their products until they do.` });
    }

    const commissionCents = Math.round(item.priceCents * LAB_COMMISSION_RATE);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: item.priceCents,
          product_data: {
            name: item.name,
            images: item.image ? [item.image] : undefined,
          },
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: commissionCents,
        transfer_data: { destination: creator.stripe_connect_account_id },
      },
      // Physical items: Stripe collects the buyer's shipping address for
      // you automatically — you'll see it on the order in your dashboard.
      // Countries listed here are a starting set; add more in Stripe
      // Dashboard settings or edit this array as you expand.
      shipping_address_collection: item.kind === 'physical'
        ? { allowed_countries: ['US', 'CA', 'GB', 'AU', 'ZA'] }
        : undefined,
      metadata: {
        type: 'shop_order',
        creator_id: creator.id,
        item_id: item.id,
        item_name: item.name,
        kind: item.kind || 'digital',
        delivery_value: item.deliveryFilePath || item.deliveryValue || '',
        delivery_type: item.deliveryFilePath ? 'file' : 'link',
      },
      success_url: `${process.env.PUBLIC_SITE_URL}/portfolio.html?u=${creator.username}&order=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_SITE_URL}/portfolio.html?u=${creator.username}`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Shop checkout error:', err);
    return res.status(500).json({ error: 'Could not start checkout.' });
  }
}
