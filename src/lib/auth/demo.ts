/**
 * The demo college's login, shared by the seed that creates it and the sign-in
 * page that offers to fill it in. Keeping one definition means the button can
 * never drift from the account that was actually seeded.
 */
export const DEMO_LOGIN = {
  email: "admin@greenfield.edu.in",
  password: "greenfield123",
};

/**
 * Whether the demo account exists and may be advertised on the sign-in page.
 *
 * This password is published in the README, so on a deployed instance the
 * button is a way in for anyone who reads the repo. `scripts/start.mjs` seeds
 * with SEED_DEMO_COLLEGE=false, so in production there is no such account to
 * offer — unless the operator deliberately turned it back on, which is the one
 * case where showing the button is what they asked for.
 *
 * Read on the server per request rather than through NEXT_PUBLIC_, which Next
 * inlines at build time and would freeze into the image.
 */
export function demoLoginEnabled(): boolean {
  if (process.env.SEED_DEMO_COLLEGE === "true") return true;
  return process.env.NODE_ENV !== "production";
}
