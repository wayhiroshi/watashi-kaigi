import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  getEventAvailability,
  reserveEventSeat,
} from "../src/worker.js";

function createSeatDb() {
  const seats = [];

  return {
    seats,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("COUNT(*) AS reserved")) {
                return { reserved: seats.filter((seat) => seat.eventId === values[0]).length };
              }
              return null;
            },
            async run() {
              if (sql.includes("DELETE FROM event_seats") && sql.includes("expires_at <= ?")) {
                const [eventId, expiresAt] = values;
                const before = seats.length;
                for (let index = seats.length - 1; index >= 0; index -= 1) {
                  const seat = seats[index];
                  if (
                    seat.eventId === eventId
                    && seat.status === "held"
                    && seat.expiresAt <= expiresAt
                  ) {
                    seats.splice(index, 1);
                  }
                }
                return { meta: { changes: before - seats.length } };
              }

              if (sql.includes("INSERT OR IGNORE INTO event_seats")) {
                const [eventId, seatNumber, orderId, expiresAt] = values;
                const occupied = seats.some((seat) => (
                  seat.eventId === eventId
                  && seat.seatNumber === seatNumber
                ));
                if (occupied) return { meta: { changes: 0 } };
                seats.push({
                  eventId,
                  seatNumber,
                  orderId,
                  checkoutSessionId: null,
                  status: "held",
                  expiresAt,
                });
                return { meta: { changes: 1 } };
              }

              if (sql.includes("SET checkout_session_id = ?")) {
                const [checkoutSessionId, orderId] = values;
                const seat = seats.find((item) => item.orderId === orderId);
                if (seat) seat.checkoutSessionId = checkoutSessionId;
                return { meta: { changes: seat ? 1 : 0 } };
              }

              if (sql.includes("DELETE FROM event_seats") && sql.includes("order_id = ?")) {
                const [orderId, checkoutSessionId] = values;
                const before = seats.length;
                for (let index = seats.length - 1; index >= 0; index -= 1) {
                  const seat = seats[index];
                  if (
                    seat.status === "held"
                    && (
                      seat.orderId === orderId
                      || seat.checkoutSessionId === checkoutSessionId
                    )
                  ) {
                    seats.splice(index, 1);
                  }
                }
                return { meta: { changes: before - seats.length } };
              }

              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
}

test("reports remaining capacity and clears expired holds", async () => {
  const db = createSeatDb();
  const now = new Date("2026-08-01T00:00:00.000Z");
  db.seats.push({
    eventId: "2026-08-30-kobe",
    seatNumber: 1,
    orderId: "expired-order",
    checkoutSessionId: "cs_expired",
    status: "held",
    expiresAt: "2026-07-31T23:59:00.000Z",
  });
  db.seats.push({
    eventId: "2026-08-30-kobe",
    seatNumber: 2,
    orderId: "paid-order",
    checkoutSessionId: "cs_paid",
    status: "paid",
    expiresAt: null,
  });

  const status = await getEventAvailability({ DB: db }, now);

  assert.equal(status.capacity, 6);
  assert.equal(status.remaining, 5);
  assert.equal(status.soldOut, false);
  assert.equal(db.seats.length, 1);
});

test("reserves at most six seats", async () => {
  const db = createSeatDb();
  const now = new Date("2026-08-01T00:00:00.000Z");

  for (let index = 1; index <= 6; index += 1) {
    const result = await reserveEventSeat({ DB: db }, `order-${index}`, now);
    assert.equal(result.seatNumber, index);
  }

  assert.equal(await reserveEventSeat({ DB: db }, "order-7", now), null);
  const status = await getEventAvailability({ DB: db }, now);
  assert.equal(status.soldOut, true);
  assert.equal(status.remaining, 0);
});

test("creates a canonical Stripe Checkout session with a 35 minute hold", async () => {
  const db = createSeatDb();
  const originalFetch = globalThis.fetch;
  let stripeRequest;
  globalThis.fetch = async (url, options) => {
    stripeRequest = { url, options };
    return new Response(JSON.stringify({
      id: "cs_test_checkout",
      url: "https://checkout.stripe.com/c/pay/cs_test_checkout",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://watashi-kaigi.aether42.com/api/create-checkout-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: "2026-08-30-kobe",
          name: "Test Participant",
          email: "participant@example.com",
          tel: "",
          aiExperience: "ほとんど使ったことがない",
          agree: true,
        }),
      }),
      {
        DB: db,
        STRIPE_SECRET_KEY: "sk_test_example",
        PUBLIC_SITE_URL: "https://watashi-kaigi.aether42.com",
      },
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, "https://checkout.stripe.com/c/pay/cs_test_checkout");
    assert.equal(stripeRequest.url, "https://api.stripe.com/v1/checkout/sessions");

    const params = new URLSearchParams(stripeRequest.options.body);
    assert.equal(params.get("payment_method_types[0]"), "card");
    assert.equal(params.get("line_items[0][price_data][unit_amount]"), "3000");
    assert.equal(params.get("metadata[event_id]"), "2026-08-30-kobe");
    assert.match(params.get("metadata[date]"), /2026年8月30日/);
    assert.ok(Number(params.get("expires_at")) > Math.floor(Date.now() / 1000) + 30 * 60);
    assert.equal(db.seats[0].checkoutSessionId, "cs_test_checkout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an unknown event before reserving a seat", async () => {
  const db = createSeatDb();
  const response = await worker.fetch(
    new Request("https://watashi-kaigi.aether42.com/api/create-checkout-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "another-event",
        name: "Test Participant",
        email: "participant@example.com",
        agree: true,
      }),
    }),
    { DB: db, STRIPE_SECRET_KEY: "sk_test_example" },
  );

  assert.equal(response.status, 400);
  assert.equal(db.seats.length, 0);
});
