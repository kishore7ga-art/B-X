/**
 * The demo college's login, used by the seed that creates the account.
 *
 * One definition so the credentials in the README, the seed and anything that
 * ever offers to fill them in cannot drift from the account actually created.
 *
 * This lived alongside a `demoLoginEnabled()` helper that decided whether the
 * sign-in page should advertise the account. Nothing in either repo ever called
 * it — the button it was written for was never built — so it has been removed
 * rather than left looking like a switch somebody is honouring.
 */
export const DEMO_LOGIN = {
  email: "admin@greenfield.edu.in",
  password: "greenfield123",
};
