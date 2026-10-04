/**
 * Church workspace admin roles — SINGLE SOURCE OF TRUTH.
 *
 * Every server-side authorization check that decides "can this user manage
 * this church's workspace (dashboard, wallet, payments, activation, SMS,
 * events)" MUST go through isChurchAdminRole(), so the page gates, server
 * actions and API routes can never drift apart again (the admin layout used
 * to accept only 'pastor' while the wallet/SMS/payment routes accepted
 * 'pastor' | 'admin' — see the 2026-10 audit).
 *
 * This matches the canonical mapping in the my_login_context RPC
 * (migrations/010_denomination_support.sql):
 *   role IN ('pastor','admin') AND tenant_id IS NOT NULL  →  church-admin
 *
 * Deliberately excluded:
 *  - 'overseer' — a denomination-level role and a separate axis. Overseer
 *    accounts are routed to the overseer portal, and the overseer gate
 *    (lib/overseer-gate.ts) plus login routing check it independently and
 *    with precedence. They are never church-admins by virtue of the role.
 *  - 'staff'    — junior role in public.admin_role_enum. No guard in the
 *    app has ever granted 'staff' access to money or messaging; opening
 *    that up is a product decision, not a consistency fix.
 */
export const CHURCH_ADMIN_ROLES = ['pastor', 'admin'] as const;

export type ChurchAdminRole = (typeof CHURCH_ADMIN_ROLES)[number];

export function isChurchAdminRole(role: unknown): role is ChurchAdminRole {
  return role === 'pastor' || role === 'admin';
}
