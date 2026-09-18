// ============================================================
// /api/stripe/shop-order-lookup
// ============================================================
// Public, but safe: the ONLY thing that unlocks an order's details
// is knowing its Stripe Checkout session ID, which only exists in
// the URL Stripe redirected the buyer to right after they paid.
// Nobody can guess or enumerate these — they're long random Stripe
// IDs — so this is the same trust model as, say, a shipment
// tracking link. It intentionally returns only what a buyer needs
// (item name, kind, delivery link) — never the creator's other
// orders, buyer list, or anything else in shop_orders.
//
// For file-based digital products (see migration_v7), the raw
// storage path is never handed to the browser — this generates a
// fresh 7-day signed URL on each call using the service_role key,
// which is the only way to read from the private
// shop-digital-products bucket at all.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });

  try {
    const { data: order, error } = await supabaseAdmin
      .from('shop_orders')
      .select('item_name, kind, delivery_value, delivery_type, status')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle();

    if (order) {
      let deliveryValue = null;
      if (order.kind === 'digital') {
        if (order.delivery_type === 'file') {
          // Never return the raw storage path — generate a fresh, short-lived
          // signed URL every time this is called. Expires in 7 days, which is
          // enough for a buyer to download without leaving a permanent public
          // link floating around forever.
          const { data: signed, error: signErr } = await supabaseAdmin
            .storage
            .from('shop-digital-products')
            .createSignedUrl(order.delivery_value, 60 * 60 * 24 * 7);
          if (signErr) console.error('Could not sign download URL:', signErr);
          else deliveryValue = signed.signedUrl;
        } else {
          deliveryValue = order.delivery_value;
        }
      }
      return res.status(200).json({ itemName: order.item_name, kind: order.kind, deliveryValue });
    }

    // Not a creator-product order — check whether it's a Lab partner
    // drop sale instead (same success-page flow, different table).
    const { data: partnerSale } = await supabaseAdmin
      .from('partner_drop_sales')
      .select('product_id, partner_products(name)')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle();

    if (partnerSale) {
      return res.status(200).json({
        itemName: partnerSale.partner_products?.name || 'your order',
        kind: 'partner_drop',
        deliveryValue: null, // fulfillment for these is off-platform (physical/brand-shipped)
      });
    }

    // Most likely the webhook hasn't landed yet (it usually arrives
    // within a second or two of the redirect) — not necessarily an error.
    return res.status(404).json({ error: 'pending' });
  } catch (err) {
    console.error('Order lookup error:', err);
    return res.status(500).json({ error: 'Could not look up order.' });
  }
}
