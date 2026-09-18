// Single source of truth for The Lab's cut of Lab-processed sales.
// Used by both api/admin/send-payout.js (Lab partner drops) and
// api/stripe/create-shop-checkout.js (a creator's own Shop products
// sold through Lab checkout). Change this one number to change the
// commission everywhere it applies — never hardcode 0.02 elsewhere.
export const LAB_COMMISSION_RATE = 0.02;

// What a creator earns for driving a sale of one of THE LAB'S OWN
// products (a priced partner drop) — different concept from the rate
// above. There, the creator owns the product and pays Us 2%. Here, We
// own the product and pay THEM a commission for the referral/promotion.
// 20% is a reasonable starting affiliate-style rate — change it here,
// not in create-partner-checkout.js or webhook.js.
export const PARTNER_DROP_CREATOR_COMMISSION_RATE = 0.20;
