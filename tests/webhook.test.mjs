import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import worker, {
  saveRegistration,
  sendOrganizerNotification,
  verifyStripeSignature,
} from "../src/worker.js";

const secret = "whsec_test_secret";
const timestamp = 1_750_000_000;
const event = {
  id: "evt_test_webhook",
  type: "checkout.session.completed",
  created: timestamp,
  data: {
    object: {
      id: "cs_test_webhook",
      payment_status: "paid",
      payment_intent: "pi_test_webhook",
      amount_total: 3000,
      currency: "jpy",
      client_reference_id: "order-test",
      customer_details: { email: "participant@example.com" },
      metadata: {
        name: "Test Participant",
        email: "participant@example.com",
        tel: "090-0000-0000",
        date: "第1回",
        ai_experience: "少しだけ使ったことがある",
      },
    },
  },
};
const payload = JSON.stringify(event);

function createFakeDb() {
  const statements = [];
  const emailState = {
    organizer_email_sent_at: null,
    organizer_email_message_id: null,
    organizer_email_last_error: null,
  };
  return {
    emailState,
    statements,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql,
            values,
            async first() {
              if (sql.includes("SELECT organizer_email_sent_at")) {
                return { organizer_email_sent_at: emailState.organizer_email_sent_at };
              }
              return null;
            },
            async run() {
              statements.push({ sql, values });
              if (sql.includes("organizer_email_sent_at = ?")) {
                emailState.organizer_email_sent_at = values[0];
                emailState.organizer_email_message_id = values[1];
                emailState.organizer_email_last_error = null;
              } else if (sql.includes("organizer_email_last_error = ?")) {
                emailState.organizer_email_last_error = values[0];
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(batchStatements) {
      statements.push(...batchStatements);
      return batchStatements.map(() => ({ success: true }));
    },
  };
}

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
  const unpaidEvent = structuredClone(event);
  unpaidEvent.data.object.payment_status = "unpaid";
  const unpaidPayload = JSON.stringify(unpaidEvent);
  const request = new Request("https://example.com/api/stripe-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signatureHeader(unpaidPayload, currentTimestamp),
    },
    body: unpaidPayload,
  });
  const db = createFakeDb();
  const response = await worker.fetch(request, {
    STRIPE_WEBHOOK_SECRET: secret,
    DB: db,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(db.statements.length, 2);
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

test("stores the Checkout registration with payment metadata", async () => {
  const db = createFakeDb();
  await saveRegistration({ DB: db }, event, event.data.object);

  assert.equal(db.statements.length, 2);
  assert.match(db.statements[0].sql, /INSERT OR IGNORE INTO stripe_events/);
  assert.deepEqual(db.statements[0].values, [
    "evt_test_webhook",
    "checkout.session.completed",
    "cs_test_webhook",
  ]);

  const registrationValues = db.statements[1].values;
  assert.equal(registrationValues[0], "order-test");
  assert.equal(registrationValues[1], "cs_test_webhook");
  assert.equal(registrationValues[2], "pi_test_webhook");
  assert.equal(registrationValues[4], "paid");
  assert.equal(registrationValues[5], 3000);
  assert.equal(registrationValues[6], "jpy");
  assert.equal(registrationValues[7], "Test Participant");
  assert.equal(registrationValues[8], "participant@example.com");
  assert.equal(registrationValues[9], "090-0000-0000");
  assert.equal(registrationValues[10], "第1回");
});

test("marks an asynchronous payment failure without a paid timestamp", async () => {
  const db = createFakeDb();
  const failedEvent = {
    ...event,
    id: "evt_test_failed",
    type: "checkout.session.async_payment_failed",
  };

  await saveRegistration({ DB: db }, failedEvent, failedEvent.data.object);

  assert.equal(db.statements[1].values[4], "failed");
  assert.equal(db.statements[1].values[12], null);
});

test("sends one organizer email and records the Resend message ID", async () => {
  const db = createFakeDb();
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ id: "email_test_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const env = {
    DB: db,
    RESEND_API_KEY: "re_test",
    ORGANIZER_EMAIL: "organizer@example.com",
    RESEND_FROM: "Watashi Kaigi <watashi-kaigi@notify.aether42.com>",
  };

  const firstResult = await sendOrganizerNotification(
    env,
    event,
    event.data.object,
    fakeFetch,
  );
  const secondResult = await sendOrganizerNotification(
    env,
    event,
    event.data.object,
    fakeFetch,
  );

  assert.deepEqual(firstResult, { sent: true, messageId: "email_test_123" });
  assert.deepEqual(secondResult, { sent: false, reason: "already_sent" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(
    requests[0].options.headers["idempotency-key"],
    "watashi-kaigi/payment-paid/cs_test_webhook",
  );

  const email = JSON.parse(requests[0].options.body);
  assert.deepEqual(email.to, ["organizer@example.com"]);
  assert.equal(email.reply_to, "participant@example.com");
  assert.match(email.subject, /Test Participant/);
  assert.match(email.text, /090-0000-0000/);
  assert.equal(db.emailState.organizer_email_message_id, "email_test_123");
  assert.ok(db.emailState.organizer_email_sent_at);
});

test("records a Resend error so Stripe can retry the webhook", async () => {
  const db = createFakeDb();
  const fakeFetch = async () => new Response(
    JSON.stringify({ message: "Domain is not verified" }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
  const env = {
    DB: db,
    RESEND_API_KEY: "re_test",
    ORGANIZER_EMAIL: "organizer@example.com",
    RESEND_FROM: "Watashi Kaigi <watashi-kaigi@notify.aether42.com>",
  };

  await assert.rejects(
    sendOrganizerNotification(env, event, event.data.object, fakeFetch),
    /Organizer notification failed/,
  );
  assert.equal(db.emailState.organizer_email_last_error, "Domain is not verified");
  assert.equal(db.emailState.organizer_email_sent_at, null);
});
