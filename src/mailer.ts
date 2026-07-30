import { Resend } from "resend";

/**
 * The one place this service sends email.
 *
 * A seam rather than a call to Resend at the point of use, for two reasons that
 * both showed up while writing step 3. The first is that an activation link is a
 * credential, so exactly one function should ever hold a raw token and it should
 * be this one. The second is that "no transport configured" is a normal state
 * here — it is how the whole flow was walked end to end before this file
 * existed — and a caller should not have to know whether mail is switched on to
 * decide whether it did its job.
 *
 * So nothing here throws. `send()` reports what happened and the caller decides;
 * see `approveAccessRequest`'s route for why an exception would be worse than a
 * bad result.
 */

export type Delivery =
  | { delivered: true; via: "resend" }
  /**
   * `reason` is for the operator, not the recipient. It reaches the admin panel
   * and the API log, never the person who asked for access.
   */
  | { delivered: false; via: "log" | "resend"; reason: string };

/** From-address. Must be on a domain verified with Resend or every send 403s. */
const from = () => process.env.MAIL_FROM?.trim();
const apiKey = () => process.env.RESEND_API_KEY?.trim();

/** Whether real mail can be sent, for the health check and the approve route. */
export function mailerConfigured(): boolean {
  return Boolean(apiKey() && from());
}

/**
 * Built per call rather than once at module load.
 *
 * The key is read from the environment, and a client constructed at import time
 * captures whatever was set then — which in this codebase has already been the
 * difference between a working deployment and a silent one, because
 * `dotenv/config` runs from `server.ts` and import order is not something to
 * bet a credential on.
 */
function client() {
  const key = apiKey();
  return key ? new Resend(key) : null;
}

/**
 * The approval email.
 *
 * Plain text alongside the HTML deliberately. A one-link email with no text part
 * is a strong spam signal, and this is the single message the entire flow
 * depends on arriving.
 *
 * The link is not shortened, wrapped or tracked. Anything that rewrites it puts
 * a third party between an invite and the person holding it, and this token is
 * the only thing standing between a stranger and somebody else's account.
 */
export async function sendActivationEmail(input: {
  to: string;
  name: string;
  activationUrl: string;
  expiresAt: Date;
}): Promise<Delivery> {
  const { to, name, activationUrl, expiresAt } = input;

  const resend = client();
  const sender = from();

  if (!resend || !sender) {
    /**
     * Not an error, and not silent either.
     *
     * Outside production the URL is printed so the loop stays walkable with no
     * mail account at all — the behaviour step 3 shipped with. In production the
     * token is deliberately withheld from the log: stdout gets shipped somewhere,
     * and a credential in a log aggregator is a credential in a place nobody
     * remembered to lock.
     */
    const reason = !apiKey()
      ? "RESEND_API_KEY is not set"
      : "MAIL_FROM is not set";

    if (process.env.NODE_ENV === "production") {
      console.warn(`[mail] not sent to ${to} — ${reason}`);
    } else {
      console.log(`[mail] no transport (${reason}). Invite for ${to}:`);
      console.log(`[mail]   ${activationUrl}`);
    }

    return { delivered: false, via: "log", reason };
  }

  const hours = Math.round((expiresAt.getTime() - Date.now()) / 3_600_000);

  try {
    const { error } = await resend.emails.send({
      from: sender,
      to,
      subject: "Your XITE access request was approved",
      text: [
        `Hi ${name},`,
        "",
        "Your request for access to XITE has been approved. Open this link to",
        "set up your account:",
        "",
        activationUrl,
        "",
        `The link works once and expires in ${hours} hours.`,
        "",
        "If you did not ask for access, you can ignore this — nothing has been",
        "created in your name.",
      ].join("\n"),
      html: activationHtml({ name, activationUrl, hours }),
    });

    if (error) {
      // Resend reports failures in the body, not by throwing.
      console.error(`[mail] resend refused the send to ${to}: ${error.message}`);
      return { delivered: false, via: "resend", reason: error.message };
    }

    console.log(`[mail] activation sent to ${to}`);
    return { delivered: true, via: "resend" };
  } catch (cause) {
    // Network, DNS, a bad key — all the same to the caller: it did not arrive.
    const reason = cause instanceof Error ? cause.message : String(cause);
    console.error(`[mail] send to ${to} failed: ${reason}`);
    return { delivered: false, via: "resend", reason };
  }
}

/**
 * Inline styles and a table-free layout, because an email client is not a
 * browser: there is no external stylesheet, `<style>` is stripped by some, and
 * flexbox is unreliable. The link is also a plain `<a>` and not a styled button
 * only — a client that drops the CSS must still show something clickable.
 */
function activationHtml(input: {
  name: string;
  activationUrl: string;
  hours: number;
}) {
  const { name, activationUrl, hours } = input;
  return [
    `<div style="font-family:ui-sans-serif,system-ui,'Segoe UI',sans-serif;`,
    `font-size:15px;line-height:1.6;color:#101828;max-width:520px">`,
    `<p>Hi ${escapeHtml(name)},</p>`,
    `<p>Your request for access to XITE has been approved.</p>`,
    `<p style="margin:28px 0">`,
    `<a href="${activationUrl}" style="background:#146ef5;color:#ffffff;`,
    `text-decoration:none;padding:12px 22px;border-radius:999px;`,
    `font-weight:600;display:inline-block">Set up my account</a>`,
    `</p>`,
    `<p style="color:#667085;font-size:13px">`,
    `The link works once and expires in ${hours} hours. If the button does not`,
    ` work, paste this into your browser:<br>`,
    `<span style="word-break:break-all">${activationUrl}</span>`,
    `</p>`,
    `<p style="color:#667085;font-size:13px">If you did not ask for access,`,
    ` you can ignore this — nothing has been created in your name.</p>`,
    `</div>`,
  ].join("");
}

/**
 * The name comes from a public, unauthenticated form and lands in HTML.
 *
 * Only `name` is interpolated from user input; the URL is ours. Escaped anyway
 * rather than trusted, because the alternative is an email whose markup is
 * written by whoever filled in the form.
 */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
