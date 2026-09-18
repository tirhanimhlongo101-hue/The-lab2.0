// ============================================================
// /lib/requireAdmin.js
// ============================================================
// Every admin action must call this FIRST. It independently
// re-checks the caller's real role from the database using the
// service role key — it never trusts anything the client claims
// about itself, including a client that "looks like" an admin
// panel. This is the actual security boundary; admin.html hiding
// buttons from non-admins is just a convenience on top of this,
// not a substitute for it.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function requireAdmin(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return { ok: false, status: 401, error: 'Missing Authorization header.' };
  }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, error: 'Invalid or expired session.' };
  }

  const { data: profileRow, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileErr || !profileRow || profileRow.role !== 'admin') {
    return { ok: false, status: 403, error: 'Admin access required.' };
  }

  return { ok: true, adminId: userData.user.id, supabaseAdmin };
}
