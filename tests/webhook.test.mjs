import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import worker, { verifyStripeSignature } from "../src/worker.js";

const secret = "whsec_test_secret";
const timestamp = 1_750_000_000;
const event = {
  id: "evt_test_webhook",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_webhook",
      payment_status: "paid",
      client_reference_id: "order-test",
      customer_details: { email: "participant@example.com" },
      metadata: { name: "Test Participant", date: "第1回" },
    },
  },
};
const payload = JSON.stringify(event);

function signatureHeader(body, at = timestamp) {
  const signature = createHmac("sha256", secret)
    .update(`${at}.${body}`)
    .digest("hex");
  return `t=${at},v1=${signature}`;
}

test("accepts a valid Stripe signature", async () => {
  assert.equal(
    await verifyStripeSignature(
      payload,
      signatureHeader(payload),
      secret,
      timestamp,
    ),
    true,
  );
});

test("rejects invalid and stale Stripe signatures", async () => {
  assert.equal(
    await verifyStripeSignature(payload, `t=${timestamp},v1=deadbeef`, secret, timestamp),
    false,
  );
  assert.equal(
    await verifyStripeSignature(
      payload,
      signatureHeader(payload),
      secret,
      timestamp + 301,
    ),
    false,
  );
});

test("webhook route accepts signed Checkout events", async () => {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const request = new Request("https://example.com/api/stripe-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signatureHeader(payload, currentTimestamp),
    },
    body: payload,
  });
  const response = await worker.fetch(request, {
    STRIPE_WEBHOOK_SECRET: secret,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
});

test("webhook route rejects unsigned requests", async () => {
  const request = new Request("https://example.com/api/stripe-webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  const response = await worker.fetch(request, {
    STRIPE_WEBHOOK_SECRET: secret,
  });

  assert.equal(response.status, 400);
});
