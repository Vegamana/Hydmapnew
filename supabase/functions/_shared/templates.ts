// Email templates. Plain string builders — no template engine, no build step.
// The HTML mirrors emails/*.html, which Python reads from disk for cron mail.
//
// Design rules that keep these out of spam folders and readable in Gmail:
//   * table-based layout, inline styles, 600px max width
//   * one primary CTA, repeated as a plain URL for clients that strip buttons
//   * a plain-text alternative for every send
import { esc } from "./validate.ts";

const BRAND = "Hyderabad Property Map";
const INK = "#0E1A24";
const LACQUER = "#0F6F5C";
const MUTED = "#6B7B85";

function shell(title: string, inner: string, footerNote: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#F3F5F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #E1E6E4;border-radius:14px;overflow:hidden;">
  <tr><td style="padding:20px 28px;border-bottom:1px solid #EDF1F0;">
    <span style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:${MUTED};">${BRAND}</span>
  </td></tr>
  <tr><td style="padding:28px;">${inner}</td></tr>
  <tr><td style="padding:18px 28px;background:#FAFBFB;border-top:1px solid #EDF1F0;font-size:12px;line-height:1.6;color:${MUTED};">
    ${footerNote}
  </td></tr>
</table></body></html>`;
}

function button(href: string, label: string, bg = LACQUER) {
  return `<a href="${href}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;
    font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px;">${esc(label)}</a>`;
}

function row(label: string, value: string) {
  return `<tr>
    <td style="padding:9px 0;width:104px;font-size:13px;color:${MUTED};vertical-align:top;">${esc(label)}</td>
    <td style="padding:9px 0;font-size:15px;font-weight:600;">${value}</td></tr>`;
}

export interface InterestMailData {
  token: string;
  listingTitle: string;
  listingPrice: number;
  listingType: string;
  listingLocality?: string | null;
  mapUrl: string;
  actionBase: string;
  name: string;
  phone: string;
  email: string;
  message?: string;
  paid: boolean;
  createdAt: string;
}

export function interestEmail(d: InterestMailData) {
  const price = `₹${Number(d.listingPrice).toLocaleString("en-IN")}`;
  const rented = `${d.actionBase}?token=${d.token}&action=rented`;

  const inner = `
    <p style="margin:0 0 4px;font-size:13px;color:${MUTED};">New enquiry</p>
    <h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;">${esc(d.name)} wants to see ${esc(d.listingTitle)}</h1>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
           style="border:1px solid #EDF1F0;border-radius:10px;padding:6px 16px;margin-bottom:20px;">
      ${row("Name", esc(d.name))}
      ${row("Phone", `<a href="tel:+91${esc(d.phone)}" style="color:${LACQUER};text-decoration:none;">+91 ${esc(d.phone)}</a>`)}
      ${row("Email", `<a href="mailto:${esc(d.email)}" style="color:${LACQUER};text-decoration:none;">${esc(d.email)}</a>`)}
      ${d.message ? row("Message", esc(d.message)) : ""}
      ${row("Received", esc(d.createdAt))}
      ${d.paid ? row("Deposit", "₹1 paid — verified contact") : ""}
    </table>

    <p style="margin:0 0 8px;font-size:13px;color:${MUTED};">Your listing</p>
    <p style="margin:0 0 22px;font-size:15px;">
      <strong>${esc(d.listingTitle)}</strong><br>
      ${price}${d.listingType === "sale" ? "" : " / month"}${d.listingLocality ? " · " + esc(d.listingLocality) : ""}
    </p>

    <p style="margin:0 0 8px;">${button(`mailto:${esc(d.email)}?subject=${encodeURIComponent("Re: " + d.listingTitle)}`, "Reply to " + d.name.split(" ")[0])}</p>
    <p style="margin:16px 0 0;font-size:14px;">
      Already rented it? ${`<a href="${rented}" style="color:${LACQUER};">Close this listing</a>`} and it stops showing on the map.
    </p>`;

  const footer = `Your email address and phone number are never shown on the map. Enquiries reach you here only.<br>
    Reply to this message to reach ${esc(d.name)} directly — keep the subject line intact so we can match your reply to the listing.`;

  const text = [
    `New enquiry for ${d.listingTitle}`,
    ``,
    `Name:  ${d.name}`,
    `Phone: +91 ${d.phone}`,
    `Email: ${d.email}`,
    d.message ? `Message: ${d.message}` : ``,
    `Received: ${d.createdAt}`,
    d.paid ? `₹1 deposit paid — verified contact` : ``,
    ``,
    `Listing: ${d.listingTitle} — ${price}`,
    `Map: ${d.mapUrl}`,
    `Already rented? Close the listing: ${rented}`,
  ].filter(Boolean).join("\n");

  return {
    subject: `${d.name} is interested in ${d.listingTitle} [HPM-${d.token}]`,
    html: shell("New enquiry", inner, footer),
    text,
  };
}

export interface AgingMailData {
  token: string;
  listingTitle: string;
  listingPrice: number;
  days: number;
  actionBase: string;
  mapUrl: string;
  interestCount: number;
}

export interface ListingConfirmationMailData {
  token: string;
  listingTitle: string;
  listingPrice: number;
  listingType: string;
  confirmUrl: string;
}

export function listingConfirmationEmail(d: ListingConfirmationMailData) {
  const price = `₹${Number(d.listingPrice).toLocaleString("en-IN")}`;

  const inner = `
    <p style="margin:0 0 4px;font-size:13px;color:${MUTED};">One step left</p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Confirm ${esc(d.listingTitle)} to put it on the map</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;">
      ${esc(d.listingTitle)} — ${price}${d.listingType === "sale" ? "" : " / month"}.
      It stays private until you confirm — nobody can see it or your contact
      details yet.
    </p>
    <p style="margin:0 0 12px;">${button(d.confirmUrl, "Confirm and publish")}</p>
    <p style="margin:18px 0 0;font-size:13px;color:${MUTED};">
      Did not post this? Ignore this email and nothing will be published.
    </p>`;

  const footer = `You will get a reminder to reconfirm every 30 days, and a one-click way to mark it rented, by email — no login, ever.`;

  const text = [
    `Confirm "${d.listingTitle}" — ${price}`,
    ``,
    `Confirm and publish: ${d.confirmUrl}`,
    ``,
    `Did not post this? Ignore this email.`,
  ].join("\n");

  return {
    subject: `Confirm your listing: ${d.listingTitle} [HPM-${d.token}]`,
    html: shell("Confirm your listing", inner, footer),
    text,
  };
}

export interface SeekerMatchMailData {
  listingTitle: string;
  listingPrice: number;
  listingType: string;
  mapUrl: string;
}

export function seekerMatchEmail(d: SeekerMatchMailData) {
  const price = `₹${Number(d.listingPrice).toLocaleString("en-IN")}`;

  const inner = `
    <p style="margin:0 0 4px;font-size:13px;color:${MUTED};">New match</p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">${esc(d.listingTitle)} just went live near your pin</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;">
      ${price}${d.listingType === "sale" ? "" : " / month"}. It matches the budget and area
      you set when you dropped your seeker pin.
    </p>
    <p style="margin:0 0 12px;">${button(d.mapUrl, "View on the map")}</p>`;

  const footer = `You are getting this because you dropped a seeker pin on the map. Matches stop if you don't want them anymore — reply and say so.`;

  const text = [
    `${d.listingTitle} just went live — ${price}${d.listingType === "sale" ? "" : " / month"}`,
    ``,
    `View on the map: ${d.mapUrl}`,
  ].join("\n");

  return {
    subject: `A match near you: ${d.listingTitle}`,
    html: shell("New match", inner, footer),
    text,
  };
}

export function agingEmail(d: AgingMailData) {
  const available = `${d.actionBase}?token=${d.token}&action=available`;
  const rented    = `${d.actionBase}?token=${d.token}&action=rented`;
  const price = `₹${Number(d.listingPrice).toLocaleString("en-IN")}`;

  const inner = `
    <p style="margin:0 0 4px;font-size:13px;color:${MUTED};">Day ${d.days} check-in</p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Is ${esc(d.listingTitle)} still available?</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;">
      It has been on the map for ${d.days} days at ${price}
      ${d.interestCount > 0 ? `and has had ${d.interestCount} ${d.interestCount === 1 ? "enquiry" : "enquiries"}` : "with no enquiries yet"}.
      One tap keeps it accurate for everyone searching.
    </p>
    <p style="margin:0 0 12px;">
      ${button(available, "Still available")}
      &nbsp;&nbsp;
      ${button(rented, "It is rented", "#4A5A64")}
    </p>
    <p style="margin:18px 0 0;font-size:14px;color:${MUTED};">
      You can also just reply to this email with <em>available</em> or <em>rented</em> — we read replies.
    </p>`;

  const footer = `Listings that go 30 days without confirmation stop appearing on the map, so nobody wastes a call on a flat that is gone.`;

  const text = [
    `Is "${d.listingTitle}" still available? (day ${d.days}, ${price})`,
    ``,
    `Still available: ${available}`,
    `It is rented:    ${rented}`,
    ``,
    `Or reply to this email with "available" or "rented".`,
    `Map: ${d.mapUrl}`,
  ].join("\n");

  return {
    subject: `Still available? ${d.listingTitle} (day ${d.days}) [HPM-${d.token}]`,
    html: shell("Still available?", inner, footer),
    text,
  };
}
