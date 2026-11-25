// Makes an admin login for the admin panel (/admin). An admin has no business: the database sees
// app_metadata.role = 'admin' on the new login and lists it in public.admins instead (supabase/schema.sql).
// The password is printed once; change it later in Supabase → Authentication → Users. Free.
// Usage: npm run smoke scripts/setup/admin.ts <email> [password]
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

const [email, given] = process.argv.slice(2);
if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error("Usage: npm run smoke scripts/setup/admin.ts <email> [password]");
  process.exit(1);
}

// No look-alike characters, so it can be read out or typed
const CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const password = given ?? Array.from(randomBytes(16), (n) => CHARS[n % CHARS.length]).join("");
if (password.length < 8) {
  console.error("Use a password of at least 8 characters.");
  process.exit(1);
}

const db = createAdminClient();
const { data, error } = await db.auth.admin.createUser({ email: email.toLowerCase(), password, email_confirm: true, app_metadata: { role: "admin" } });
if (error) {
  console.error(`Couldn't make the login: ${error.message}`);
  process.exit(1);
}

// The database lists it by itself (trigger brandwright_create_business); this covers a login made before the schema ran
const { error: listError } = await db.from("admins").upsert({ user_id: data.user.id });
if (listError) console.log(`Not in the admins list yet (${listError.message}). Run supabase/schema.sql first: its trigger lists every login made with the admin role.`);

// Supabase saves the login before it adds app_metadata, so the trigger can miss the admin role and make the
// login a business of its own. An admin has none (a login with a business is sent to onboarding), so remove it.
const removed = await removeOwnBusinesses(data.user.id);
if (removed) console.log(`Removed the empty business made for this login (${removed}).`);

console.log(`Admin login ready\n  Email:    ${data.user.email}\n  Password: ${password}\n  Open /login, then /admin.`);

/** Deletes the businesses this login owns that were never set up (everything in them cascades). */
async function removeOwnBusinesses(userId: string): Promise<number> {
  const { data: owned, error } = await db.from("businesses").select("id, business_profile(onboarding_status)").eq("owner_id", userId);
  if (error) {
    console.log(`Couldn't check for a business made for this login (${error.message}). Delete it in Supabase if the login opens onboarding.`);
    return 0;
  }
  const unused = (owned ?? []).filter((b) => {
    const profile = Array.isArray(b.business_profile) ? b.business_profile[0] : b.business_profile;
    return !profile || profile.onboarding_status === "not_started";
  });
  if (!unused.length) return 0;
  const { error: deleteError } = await db.from("businesses").delete().in("id", unused.map((b) => b.id));
  if (deleteError) {
    console.log(`Couldn't remove the business made for this login (${deleteError.message}). Delete it in Supabase.`);
    return 0;
  }
  return unused.length;
}
