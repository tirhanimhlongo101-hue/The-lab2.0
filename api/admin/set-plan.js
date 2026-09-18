// ============================================================
// /api/admin/set-plan
// ============================================================
// The `plan` column on profiles is locked away from every client
// session (even an admin's own) at the database level — see
// migration_v3.sql. This is the ONLY way it can change until real
// payment webhooks are wired up. Every call is logged to
// payment_events for a real audit trail.
// ============================================================

import { requireAdmin } from '../../lib/requireAdmin.js';

const VALID_PLANS = ['free', 'pro', 'studio'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.status).json({ error: admin.error });

  const { targetUserId, plan } = req.body || {};
  if (!targetUserId || !VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: 'targetUserId and a valid plan are required.' });
  }

  const { error: updateErr } = await admin.supabaseAdmin
    .from('profiles')
    .update({ plan, plan_updated_at: new Date().toISOString() })
    .eq('id', targetUserId);

  if (updateErr) {
    console.error(updateErr);
    return res.status(500).json({ error: 'Could not update plan.' });
  }

  await admin.supabaseAdmin.from('payment_events').insert({
    provider: 'manual',
    event_type: 'plan_set_by_admin',
    user_id: targetUserId,
    raw_payload: { plan, set_by: admin.adminId },
  });

  return res.status(200).json({ ok: true });
}
