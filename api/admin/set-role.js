// ============================================================
// /api/admin/set-role
// ============================================================
// Lets an admin approve a signed-up business account as a "brand"
// so they can send deal offers to creators. Deliberately does NOT
// allow granting the 'admin' role through this endpoint at all —
// promoting a new admin stays a manual, one-off SQL Editor action
// (see the bottom of migration_v3.sql). This limits the damage a
// compromised admin session or a bug in this endpoint could do:
// worst case is someone gets marked 'brand', not 'admin'.
// ============================================================

import { requireAdmin } from '../../lib/requireAdmin.js';

const ALLOWED_TARGET_ROLES = ['creator', 'brand']; // 'admin' is intentionally excluded

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const admin = await requireAdmin(req);
  if (!admin.ok) return res.status(admin.status).json({ error: admin.error });

  const { targetUserId, role } = req.body || {};
  if (!targetUserId || !ALLOWED_TARGET_ROLES.includes(role)) {
    return res.status(400).json({ error: "targetUserId and a valid role ('creator' or 'brand') are required." });
  }

  const { error: updateErr } = await admin.supabaseAdmin
    .from('profiles')
    .update({ role })
    .eq('id', targetUserId);

  if (updateErr) {
    console.error(updateErr);
    return res.status(500).json({ error: 'Could not update role.' });
  }

  return res.status(200).json({ ok: true });
}
