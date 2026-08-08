// Thin Resend wrapper + email_events bookkeeping.
// Every send is recorded with a token so a reply can be traced back to a
// listing by python/jobs/email_processor.py.
import { db } from "./db.ts";

const API = "https://api.resend.com/emails";

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  kind: "interest_notification" | "aging_reminder" | "comment_notification" | "listing_confirmation" | "seeker_match";
  listingId?: string;
  interestId?: string;
}

/** Creates the email_events row first so the token can be woven into the copy. */
export async function reserveToken(args: Omit<SendArgs, "html" | "text" | "subject"> & { subject?: string }) {
  const { data, error } = await db()
    .from("email_events")
    .insert({
      kind: args.kind,
      listing_id: args.listingId ?? null,
      interest_id: args.interestId ?? null,
      to_email: args.to,
      subject: args.subject ?? null,
    })
    .select("id, token")
    .single();
  if (error) throw new Error(`email_events insert failed: ${error.message}`);
  return data as { id: string; token: string };
}

export async function send(args: SendArgs & { eventId?: string; token?: string }) {
  const key  = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM") ?? "Hyderabad Property Map <notify@example.com>";
  if (!key) throw new Error("RESEND_API_KEY is not set");

  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
      reply_to: args.replyTo ?? Deno.env.get("REPLY_TO_ADDRESS") ?? undefined,
      // Tag so Resend analytics can separate transactional streams.
      tags: [{ name: "kind", value: args.kind }],
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(payload)}`);

  if (args.eventId) {
    await db().from("email_events")
      .update({ provider_id: payload.id ?? null, subject: args.subject })
      .eq("id", args.eventId);
  }
  return payload as { id?: string };
}
