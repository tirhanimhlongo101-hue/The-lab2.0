// ============================================================
// Every page in this project loads /config.js directly (see the
// <script src="config.js"> tag near the top of each .html file),
// but it was never part of either upload — presumably left out on
// purpose because it's public-ish but still project-specific.
//
// Copy this file to config.js (same folder) and fill in your own
// project's values from Supabase Dashboard → Project Settings → API.
// The anon/public key is safe to expose in client-side code like
// this — it's what Row Level Security exists to protect against.
// Never put your service_role key in this file or anywhere in the
// browser-facing code; it only belongs in server-side environment
// variables (see the api/ folder).
// ============================================================

const supabaseClient = window.supabase.createClient(
  'https://YOUR-PROJECT-REF.supabase.co',   // Project URL
  'YOUR-ANON-PUBLIC-KEY'                     // anon / public key
);
