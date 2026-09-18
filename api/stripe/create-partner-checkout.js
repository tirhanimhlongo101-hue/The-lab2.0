// ============================================================
// /api/stripe/create-partner-checkout
// ============================================================
// Different money flow from api/stripe/create-shop-checkout.js on
// purpose: THAT file sells a creator's own product, so the money
// goes to the creator's connected Stripe account. THIS file sells
// one of the PLATFORM's own products (a priced Lab partner drop) —
// there's no destination/transfer at all here; the charge just goes
// to the platform's own Stripe account, same as a subscription
// payment would. The creator who showcased it earns a commission
// afterward (see webhook.js + api/admin/pay-partner-commission.js),
// tracked separately rather than split at the moment of payment.
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

  const { productId, creatorId } = req.body || {};
  if (!productId || !creatorId) return res.status(400).json({ error: 'productId and creatorId are required.' });

  try {
    // Never trust a price from the client — always re-read it from the
    // database, same principle as create-shop-checkout.js.
    const { data: product, error: productErr } = await supabaseAdmin
      .from('partner_products')
      .select('id, name, image_url, price_cents, active')
      .eq('id', productId)
      .maybeSingle();
    if (productErr || !product || !product.active) return res.status(404).json({ error: 'Product not found.' });
    if (!product.price_cents) return res.status(400).json({ error: "This product isn't set up for checkout — it's a showcase-only item." });

    // Confirm the creator legitimately has this product assigned and
    // accepted — someone can't buy a "partner drop" through a creator
    // page that was never actually offered that product.
    const { data: assignment } = await supabaseAdmin
      .from('partner_assignments')
      .select('id')
      .eq('product_id', productId)
      .eq('creator_id', creatorId)
      .eq('status', 'accepted')
      .maybeSingle();
    if (!assignment) return res.status(400).json({ error: 'This product is not available through this creator.' });

    const { data: creator } = await supabaseAdmin.from('profiles').select('username').eq('id', creatorId).maybeSingle();
    if (!creator) return res.status(404).json({ error: 'Creator not found.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: product.price_cents,
          product_data: { name: product.name, images: product.image_url ? [product.image_url] : undefined },
        },
        quantity: 1,
      }],
      // No payment_intent_data.transfer_data here — deliberately. This
      // money belongs to the platform; see file header.
      metadata: {
        type: 'partner_drop_order',
        product_id: product.id,
        creator_id: creatorId,
      },
      success_url: `${process.env.PUBLIC_SITE_URL}/portfolio.html?u=${creator.username}&order=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.PUBLIC_SITE_URL}/portfolio.html?u=${creator.username}`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Partner drop checkout error:', err);
    return res.status(500).json({ error: 'Could not start checkout.' });
  }
}
