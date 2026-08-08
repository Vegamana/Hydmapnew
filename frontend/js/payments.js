/**
 * Razorpay checkout.
 *
 * The rule that shapes this file: payment never blocks submission. By the time
 * checkout opens, the enquiry is already stored and the owner has already been
 * emailed. So every failure path here — script not loaded, modal dismissed,
 * card declined — resolves rather than rejects, and the user is told their
 * enquiry went through regardless.
 *
 * The browser's success callback is treated as a hint only. The authoritative
 * payment status is written by the razorpay_webhook edge function.
 *
 * checkout.js is loaded lazily, right here, instead of as a blocking <script>
 * tag in index.html: most visitors never opt into the ₹1 toggle, so most page
 * loads have no business paying Razorpay's checkout script for a fetch it
 * won't use.
 */
import { CONFIG } from "./config.js";

let scriptPromise = null;

function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve(true);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

export async function checkout({ order, name, email, phone, listingTitle }) {
  const loaded = await loadRazorpayScript();
  if (!loaded || !order?.order_id) {
    return { status: "unavailable" };
  }

  return new Promise((resolve) => {
    const razorpay = new window.Razorpay({
      key: order.key_id || CONFIG.RAZORPAY_KEY_ID,
      order_id: order.order_id,
      amount: order.amount,
      currency: order.currency || "INR",
      name: "Hyderabad Property Map",
      description: `Verify your enquiry — ${listingTitle}`.slice(0, 100),
      prefill: { name, email, contact: phone },
      theme: { color: "#0F6F5C" },
      retry: { enabled: false },
      handler: (response) => resolve({ status: "success", response }),
      modal: {
        ondismiss: () => resolve({ status: "dismissed" }),
        escape: true,
      },
    });

    razorpay.on("payment.failed", (event) => {
      console.warn("payment failed", event?.error?.description);
      resolve({ status: "failed", error: event?.error });
    });

    razorpay.open();
  });
}
