import { createRemoteJWKSet, jwtVerify } from "jose";

const STRIPE_API_VERSION = "2026-06-24.dahlia";
const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const EVENT_NAME = "AIで考える、これからの私会議 参加費";
const EVENT_PRICE_JPY = 3000;
const EVENT = Object.freeze({
  id: "2026-08-30-kobe",
  date: "2026年8月30日（日）",
  time: "14:00〜15:30",
  reception: "13:30",
  capacity: 6,
  venueName: "マイスぺ24 神戸スペース",
  venueAddress: "兵庫県神戸市中央区相生町4-8-20 U.C神戸駅前BLDG. 301号室",
  venueAccess: "JR神戸駅中央口から徒歩3分",
});
const CHECKOUT_HOLD_MINUTES = 35;
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function adminJsonResponse(body, status = 200) {
  const response = jsonResponse(body, status);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncateMetadata(value, maxLength = 500) {
  return asString(value).slice(0, maxLength);
}

function escapeHtml(value) {
  return asString(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatAmount(amount, currency) {
  if (!Number.isInteger(amount)) return "不明";
  if (asString(currency).toLowerCase() === "jpy") {
    return `${amount.toLocaleString("ja-JP")}円`;
  }
  return `${amount} ${asString(currency).toUpperCase()}`.trim();
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parseStripeSignature(header) {
  const values = { timestamp: "", signatures: [] };

  asString(header).split(",").forEach((part) => {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t") values.timestamp = value || "";
    if (key === "v1" && value) values.signatures.push(value);
  });

  return values;
}

export async function verifyStripeSignature(
  payload,
  signatureHeader,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  const timestampNumber = Number(timestamp);

  if (!timestamp || !Number.isFinite(timestampNumber) || signatures.length === 0) {
    return false;
  }
  if (Math.abs(nowSeconds - timestampNumber) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedPayload = encoder.encode(`${timestamp}.${payload}`);

  for (const signature of signatures) {
    const signatureBytes = hexToBytes(signature);
    if (!signatureBytes) continue;

    if (await crypto.subtle.verify("HMAC", key, signatureBytes, signedPayload)) {
      return true;
    }
  }

  return false;
}

function getBaseUrl(request, env) {
  const configured = asString(env.PUBLIC_SITE_URL);
  if (configured) return configured.replace(/\/+$/, "");

  const url = new URL(request.url);
  return url.origin;
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  const contentLength = Number(request.headers.get("content-length") || "0");

  if (!contentType.includes("application/json")) {
    throw new Error("JSON形式で送信してください。");
  }

  if (contentLength > 10000) {
    throw new Error("送信内容が大きすぎます。");
  }

  return request.json();
}

function validateCheckoutPayload(payload) {
  const name = asString(payload.name);
  const email = asString(payload.email);
  const tel = asString(payload.tel);
  const eventId = asString(payload.eventId);
  const aiExperience = asString(payload.aiExperience) || "未選択";
  const agree = payload.agree === true;

  if (!name) return { error: "お名前を入力してください。" };
  if (!email) return { error: "メールアドレスを入力してください。" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "メールアドレスの形式をご確認ください。" };
  }
  if (eventId !== EVENT.id) return { error: "開催回を確認できませんでした。" };
  if (!agree) return { error: "同意にチェックを入れてください。" };

  return { value: { name, email, tel, eventId, aiExperience } };
}

function appendMetadata(params, prefix, metadata) {
  Object.entries(metadata).forEach(([key, value]) => {
    params.set(`${prefix}[${key}]`, truncateMetadata(value));
  });
}

async function releaseExpiredSeatHolds(env, now = new Date()) {
  await env.DB.prepare(`
    DELETE FROM event_seats
    WHERE event_id = ?
      AND status = 'held'
      AND expires_at <= ?
  `).bind(EVENT.id, now.toISOString()).run();
}

export async function getEventAvailability(env, now = new Date()) {
  if (!env.DB) throw new Error("D1 database binding is missing");
  await releaseExpiredSeatHolds(env, now);
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS reserved
    FROM event_seats
    WHERE event_id = ?
  `).bind(EVENT.id).first();
  const reserved = Number(result?.reserved || 0);
  const remaining = Math.max(0, EVENT.capacity - reserved);

  return {
    id: EVENT.id,
    date: EVENT.date,
    time: EVENT.time,
    reception: EVENT.reception,
    capacity: EVENT.capacity,
    remaining,
    soldOut: remaining === 0,
    venueName: EVENT.venueName,
    venueAccess: EVENT.venueAccess,
  };
}

export async function reserveEventSeat(env, orderId, now = new Date()) {
  if (!env.DB) throw new Error("D1 database binding is missing");
  await releaseExpiredSeatHolds(env, now);
  const expiresAt = new Date(
    now.getTime() + CHECKOUT_HOLD_MINUTES * 60 * 1000,
  );

  for (let seatNumber = 1; seatNumber <= EVENT.capacity; seatNumber += 1) {
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO event_seats (
        event_id,
        seat_number,
        order_id,
        status,
        expires_at
      ) VALUES (?, ?, ?, 'held', ?)
    `).bind(EVENT.id, seatNumber, orderId, expiresAt.toISOString()).run();

    if (Number(result.meta?.changes || 0) === 1) {
      return { seatNumber, expiresAt };
    }
  }

  return null;
}

async function attachCheckoutSessionToSeat(env, orderId, checkoutSessionId) {
  await env.DB.prepare(`
    UPDATE event_seats
    SET checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE order_id = ?
  `).bind(checkoutSessionId, orderId).run();
}

async function releaseEventSeat(env, session) {
  if (!env.DB) return;
  const metadata = session.metadata || {};
  const orderId = asString(session.client_reference_id || metadata.order_id);
  const checkoutSessionId = asString(session.id);
  if (!orderId && !checkoutSessionId) return;

  await env.DB.prepare(`
    DELETE FROM event_seats
    WHERE status = 'held'
      AND (order_id = ? OR checkout_session_id = ?)
  `).bind(orderId, checkoutSessionId).run();
}

async function confirmEventSeat(env, session) {
  const metadata = session.metadata || {};
  const orderId = asString(session.client_reference_id || metadata.order_id);
  const checkoutSessionId = asString(session.id);
  if (!orderId || !checkoutSessionId) return;

  await env.DB.prepare(`
    UPDATE event_seats
    SET
      status = 'paid',
      checkout_session_id = ?,
      expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE order_id = ?
  `).bind(checkoutSessionId, orderId).run();
}

async function createCheckoutSession(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(
      { error: "Stripeの秘密鍵が設定されていません。" },
      500,
    );
  }
  if (!env.DB) {
    return jsonResponse({ error: "申込枠を確認できませんでした。" }, 500);
  }

  let payload;
  try {
    payload = await readJson(request);
  } catch (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  const validation = validateCheckoutPayload(payload);
  if (validation.error) return jsonResponse({ error: validation.error }, 400);

  const { name, email, tel, eventId, aiExperience } = validation.value;
  const baseUrl = getBaseUrl(request, env);
  const orderId = crypto.randomUUID();
  const seatHold = await reserveEventSeat(env, orderId);
  if (!seatHold) {
    return jsonResponse(
      { error: "満席となりました。次回開催のご案内をお待ちください。", soldOut: true },
      409,
    );
  }
  const metadata = {
    order_id: orderId,
    event_id: eventId,
    name,
    email,
    tel: tel || "未入力",
    date: `${EVENT.date} ${EVENT.time}`,
    ai_experience: aiExperience,
  };

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("locale", "ja");
  params.set("submit_type", "pay");
  params.set("payment_method_types[0]", "card");
  params.set("customer_email", email);
  params.set("client_reference_id", orderId);
  params.set("expires_at", String(Math.floor(seatHold.expiresAt.getTime() / 1000)));
  params.set("success_url", `${baseUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}#entry`);
  params.set("cancel_url", `${baseUrl}/?payment=cancelled#entry`);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "jpy");
  params.set("line_items[0][price_data][unit_amount]", String(EVENT_PRICE_JPY));
  params.set(
    "line_items[0][price_data][product_data][name]",
    `${EVENT_NAME}（${EVENT.date}）`,
  );
  params.set(
    "custom_text[submit][message]",
    "決済完了後、会場詳細を記載した確認メールをお送りします。",
  );
  appendMetadata(params, "metadata", metadata);
  appendMetadata(params, "payment_intent_data[metadata]", metadata);

  let stripeResponse;
  try {
    stripeResponse = await fetch(STRIPE_CHECKOUT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": STRIPE_API_VERSION,
      },
      body: params,
    });
  } catch (error) {
    await releaseEventSeat(env, { client_reference_id: orderId });
    console.error(JSON.stringify({ event: "stripe_network_error", error: error.message }));
    return jsonResponse(
      { error: "Stripe決済ページに接続できませんでした。時間をおいて再度お試しください。" },
      502,
    );
  }

  let stripePayload;
  try {
    stripePayload = await stripeResponse.json();
  } catch (error) {
    await releaseEventSeat(env, { client_reference_id: orderId });
    console.error(JSON.stringify({ event: "stripe_invalid_json", error: error.message }));
    return jsonResponse({ error: "Stripeからの応答を確認できませんでした。" }, 502);
  }

  if (!stripeResponse.ok || !stripePayload.url) {
    await releaseEventSeat(env, { client_reference_id: orderId });
    console.error(JSON.stringify({
      event: "stripe_checkout_session_failed",
      status: stripeResponse.status,
      message: stripePayload.error?.message,
      type: stripePayload.error?.type,
    }));
    return jsonResponse(
      { error: "Stripe決済ページを準備できませんでした。時間をおいて再度お試しください。" },
      502,
    );
  }

  await attachCheckoutSessionToSeat(env, orderId, asString(stripePayload.id));
  return jsonResponse({ url: stripePayload.url, orderId });
}

export async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error(JSON.stringify({ event: "stripe_webhook_secret_missing" }));
    return jsonResponse({ error: "Webhook設定を確認できません。" }, 500);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 1000000) {
    return jsonResponse({ error: "Webhookの内容が大きすぎます。" }, 413);
  }

  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") || "";
  const isValid = await verifyStripeSignature(
    payload,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );

  if (!isValid) {
    console.warn(JSON.stringify({ event: "stripe_webhook_signature_invalid" }));
    return jsonResponse({ error: "Webhook署名を確認できません。" }, 400);
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(payload);
  } catch {
    return jsonResponse({ error: "WebhookのJSONを確認できません。" }, 400);
  }

  const session = stripeEvent.data?.object || {};
  const isCheckoutEvent = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
  ].includes(stripeEvent.type);
  const isPaid = (
    stripeEvent.type === "checkout.session.async_payment_succeeded"
    || (
      stripeEvent.type === "checkout.session.completed"
      && session.payment_status === "paid"
    )
  );

  if (isCheckoutEvent) {
    await saveRegistration(env, stripeEvent, session);

    if (isPaid) {
      await confirmEventSeat(env, session);
      await sendOrganizerNotification(env, stripeEvent, session);
      await sendParticipantConfirmation(env, stripeEvent, session);
    } else if (stripeEvent.type === "checkout.session.async_payment_failed") {
      await releaseEventSeat(env, session);
    }
  } else if (stripeEvent.type === "checkout.session.expired") {
    await releaseEventSeat(env, session);
  }

  const logPayload = {
    event: "stripe_webhook_received",
    stripe_event_id: stripeEvent.id,
    stripe_event_type: stripeEvent.type,
    checkout_session_id: session.id,
    payment_status: session.payment_status,
    order_id: session.client_reference_id || session.metadata?.order_id,
    event_id: session.metadata?.event_id,
  };

  if (isPaid) {
    console.log(JSON.stringify({ ...logPayload, event: "stripe_checkout_paid" }));
  } else if (stripeEvent.type === "checkout.session.async_payment_failed") {
    console.warn(JSON.stringify({ ...logPayload, event: "stripe_checkout_payment_failed" }));
  } else if (stripeEvent.type === "checkout.session.expired") {
    console.log(JSON.stringify({ ...logPayload, event: "stripe_checkout_expired" }));
  } else {
    console.log(JSON.stringify(logPayload));
  }

  return jsonResponse({ received: true });
}

export async function saveRegistration(env, stripeEvent, session) {
  if (!env.DB) {
    throw new Error("D1 database binding is missing");
  }

  const metadata = session.metadata || {};
  const orderId = asString(session.client_reference_id || metadata.order_id);
  const checkoutSessionId = asString(session.id);
  const participantEmail = asString(
    session.customer_details?.email || session.customer_email || metadata.email,
  );
  const participantName = asString(metadata.name || session.customer_details?.name);

  if (!stripeEvent.id || !orderId || !checkoutSessionId || !participantEmail) {
    throw new Error("Stripe Checkout event is missing registration fields");
  }

  const paymentStatus = stripeEvent.type === "checkout.session.async_payment_failed"
    ? "failed"
    : asString(session.payment_status) || "unknown";
  const paidAt = paymentStatus === "paid"
    ? new Date((stripeEvent.created || Math.floor(Date.now() / 1000)) * 1000).toISOString()
    : null;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO stripe_events (
        stripe_event_id,
        event_type,
        checkout_session_id
      ) VALUES (?, ?, ?)
    `).bind(stripeEvent.id, stripeEvent.type, checkoutSessionId),
    env.DB.prepare(`
      INSERT INTO registrations (
        order_id,
        event_id,
        checkout_session_id,
        payment_intent_id,
        latest_stripe_event_id,
        payment_status,
        amount_total,
        currency,
        participant_name,
        participant_email,
        participant_tel,
        event_date,
        ai_experience,
        paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkout_session_id) DO UPDATE SET
        event_id = excluded.event_id,
        payment_intent_id = excluded.payment_intent_id,
        latest_stripe_event_id = excluded.latest_stripe_event_id,
        payment_status = excluded.payment_status,
        amount_total = excluded.amount_total,
        currency = excluded.currency,
        participant_name = excluded.participant_name,
        participant_email = excluded.participant_email,
        participant_tel = excluded.participant_tel,
        event_date = excluded.event_date,
        ai_experience = excluded.ai_experience,
        paid_at = COALESCE(excluded.paid_at, registrations.paid_at),
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      orderId,
      asString(metadata.event_id) || EVENT.id,
      checkoutSessionId,
      asString(session.payment_intent) || null,
      stripeEvent.id,
      paymentStatus,
      Number.isInteger(session.amount_total) ? session.amount_total : null,
      asString(session.currency) || null,
      participantName || "未入力",
      participantEmail,
      asString(metadata.tel) || null,
      asString(metadata.date) || null,
      asString(metadata.ai_experience) || null,
      paidAt,
    ),
  ]);
}

export async function sendOrganizerNotification(
  env,
  stripeEvent,
  session,
  fetchImpl = fetch,
) {
  if (!env.DB) throw new Error("D1 database binding is missing");
  if (!env.RESEND_API_KEY) throw new Error("Resend API key is missing");

  const organizerEmail = asString(env.ORGANIZER_EMAIL);
  const from = asString(env.RESEND_FROM);
  if (!organizerEmail || !from) {
    throw new Error("Organizer email configuration is missing");
  }

  const metadata = session.metadata || {};
  const checkoutSessionId = asString(session.id);
  const orderId = asString(session.client_reference_id || metadata.order_id);
  const participantName = asString(metadata.name || session.customer_details?.name) || "未入力";
  const participantEmail = asString(
    session.customer_details?.email || session.customer_email || metadata.email,
  );
  const participantTel = asString(metadata.tel) || "未入力";
  const eventDate = asString(metadata.date) || "未選択";
  const aiExperience = asString(metadata.ai_experience) || "未選択";
  const paymentIntentId = asString(session.payment_intent) || "未取得";
  const amount = formatAmount(session.amount_total, session.currency);

  if (!checkoutSessionId || !orderId || !participantEmail) {
    throw new Error("Stripe Checkout event is missing notification fields");
  }

  const existing = await env.DB.prepare(`
    SELECT organizer_email_sent_at
    FROM registrations
    WHERE checkout_session_id = ?
  `).bind(checkoutSessionId).first();

  if (existing?.organizer_email_sent_at) {
    return { sent: false, reason: "already_sent" };
  }

  const subject = `【私会議】決済完了: ${participantName}様（${eventDate}）`;
  const text = [
    "私会議への申し込みと決済が完了しました。",
    "",
    `お名前: ${participantName}`,
    `メール: ${participantEmail}`,
    `電話番号: ${participantTel}`,
    `参加希望日: ${eventDate}`,
    `AI利用経験: ${aiExperience}`,
    `決済金額: ${amount}`,
    `決済状態: ${asString(session.payment_status) || "paid"}`,
    `注文ID: ${orderId}`,
    `Checkout Session: ${checkoutSessionId}`,
    `Payment Intent: ${paymentIntentId}`,
    `Stripe Event: ${asString(stripeEvent.id)}`,
  ].join("\n");
  const html = `
    <h1 style="font-size:20px">私会議への決済が完了しました</h1>
    <table style="border-collapse:collapse">
      <tbody>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">お名前</th><td>${escapeHtml(participantName)}</td></tr>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">メール</th><td>${escapeHtml(participantEmail)}</td></tr>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">電話番号</th><td>${escapeHtml(participantTel)}</td></tr>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">参加希望日</th><td>${escapeHtml(eventDate)}</td></tr>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">AI利用経験</th><td>${escapeHtml(aiExperience)}</td></tr>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">決済金額</th><td>${escapeHtml(amount)}</td></tr>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">注文ID</th><td>${escapeHtml(orderId)}</td></tr>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">Checkout Session</th><td>${escapeHtml(checkoutSessionId)}</td></tr>
        <tr><th style="padding:6px 12px 6px 0;text-align:left">Payment Intent</th><td>${escapeHtml(paymentIntentId)}</td></tr>
      </tbody>
    </table>
  `;

  const resendResponse = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `watashi-kaigi/payment-paid/${checkoutSessionId}`,
    },
    body: JSON.stringify({
      from,
      to: [organizerEmail],
      reply_to: participantEmail,
      subject,
      text,
      html,
    }),
  });

  let resendPayload;
  try {
    resendPayload = await resendResponse.json();
  } catch {
    resendPayload = {};
  }

  if (!resendResponse.ok || !resendPayload.id) {
    const errorMessage = asString(resendPayload.message) || `HTTP ${resendResponse.status}`;
    await env.DB.prepare(`
      UPDATE registrations
      SET organizer_email_last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE checkout_session_id = ?
    `).bind(errorMessage.slice(0, 500), checkoutSessionId).run();
    throw new Error(`Organizer notification failed: ${errorMessage}`);
  }

  const sentAt = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE registrations
    SET
      organizer_email_sent_at = ?,
      organizer_email_message_id = ?,
      organizer_email_last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE checkout_session_id = ?
  `).bind(sentAt, resendPayload.id, checkoutSessionId).run();

  console.log(JSON.stringify({
    event: "organizer_notification_sent",
    checkout_session_id: checkoutSessionId,
    resend_message_id: resendPayload.id,
  }));

  return { sent: true, messageId: resendPayload.id };
}

export async function sendParticipantConfirmation(
  env,
  stripeEvent,
  session,
  fetchImpl = fetch,
) {
  if (!env.DB) throw new Error("D1 database binding is missing");
  if (!env.RESEND_API_KEY) throw new Error("Resend API key is missing");

  const from = asString(env.RESEND_FROM);
  const organizerEmail = asString(env.ORGANIZER_EMAIL);
  if (!from || !organizerEmail) {
    throw new Error("Participant email configuration is missing");
  }

  const metadata = session.metadata || {};
  const checkoutSessionId = asString(session.id);
  const participantName = asString(metadata.name || session.customer_details?.name) || "参加者";
  const participantEmail = asString(
    session.customer_details?.email || session.customer_email || metadata.email,
  );
  if (!checkoutSessionId || !participantEmail) {
    throw new Error("Stripe Checkout event is missing participant email fields");
  }

  const existing = await env.DB.prepare(`
    SELECT participant_email_sent_at
    FROM registrations
    WHERE checkout_session_id = ?
  `).bind(checkoutSessionId).first();

  if (existing?.participant_email_sent_at) {
    return { sent: false, reason: "already_sent" };
  }

  const subject = `【私会議】お申し込みありがとうございます｜${EVENT.date}`;
  const cancellation = [
    "キャンセルについて",
    "・開催7日前まで：全額返金",
    "・開催6日前以降：返金はありませんが、次回開催へ1回振替できます",
    "・当日の欠席・無連絡：返金・振替の対象外です",
    "・主催者都合で中止する場合：全額返金します",
  ];
  const text = [
    `${participantName}様`,
    "",
    "私会議へのお申し込みと決済が完了しました。",
    "当日は、下記の会場へお越しください。",
    "",
    `開催日：${EVENT.date}`,
    `時間：${EVENT.time}（受付 ${EVENT.reception}）`,
    `会場：${EVENT.venueName}`,
    `住所：${EVENT.venueAddress}`,
    `アクセス：${EVENT.venueAccess}`,
    "※会場は3階です。エレベーターはありません。",
    "",
    "持ち物",
    "・スマートフォンまたはノートパソコン",
    "・普段使っている充電器",
    "・事前にChatGPTへログインしておくと、当日スムーズです",
    "",
    "AIを使うときのお願い",
    "住所、健康情報、勤務先の機密情報など、他人に見られて困る情報は入力しないでください。",
    "AIの回答は誤ることがあります。医療・法律など専門的な判断は、必ず専門家へご相談ください。",
    "",
    ...cancellation,
    "",
    "ご不明な点は、このメールへ返信してください。",
    "当日お会いできることを楽しみにしています。",
    "",
    "私会議",
    "企画・運営：エーテル",
    `Stripe Event：${asString(stripeEvent.id)}`,
  ].join("\n");
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Noto Sans JP',sans-serif;line-height:1.8;color:#332b27;max-width:640px">
      <p>${escapeHtml(participantName)}様</p>
      <p>私会議へのお申し込みと決済が完了しました。<br>当日は、下記の会場へお越しください。</p>
      <h2 style="font-size:18px;margin-top:28px">開催情報</h2>
      <table style="border-collapse:collapse">
        <tbody>
          <tr><th style="padding:5px 16px 5px 0;text-align:left;vertical-align:top">開催日</th><td>${escapeHtml(EVENT.date)}</td></tr>
          <tr><th style="padding:5px 16px 5px 0;text-align:left;vertical-align:top">時間</th><td>${escapeHtml(EVENT.time)}（受付 ${escapeHtml(EVENT.reception)}）</td></tr>
          <tr><th style="padding:5px 16px 5px 0;text-align:left;vertical-align:top">会場</th><td>${escapeHtml(EVENT.venueName)}</td></tr>
          <tr><th style="padding:5px 16px 5px 0;text-align:left;vertical-align:top">住所</th><td>${escapeHtml(EVENT.venueAddress)}</td></tr>
          <tr><th style="padding:5px 16px 5px 0;text-align:left;vertical-align:top">アクセス</th><td>${escapeHtml(EVENT.venueAccess)}</td></tr>
        </tbody>
      </table>
      <p><strong>会場は3階です。エレベーターはありません。</strong></p>
      <h2 style="font-size:18px;margin-top:28px">持ち物</h2>
      <ul>
        <li>スマートフォンまたはノートパソコン</li>
        <li>普段使っている充電器</li>
        <li>事前にChatGPTへログインしておくと、当日スムーズです</li>
      </ul>
      <h2 style="font-size:18px;margin-top:28px">AIを使うときのお願い</h2>
      <p>住所、健康情報、勤務先の機密情報など、他人に見られて困る情報は入力しないでください。AIの回答は誤ることがあります。医療・法律など専門的な判断は、必ず専門家へご相談ください。</p>
      <h2 style="font-size:18px;margin-top:28px">キャンセルについて</h2>
      <ul>
        <li>開催7日前まで：全額返金</li>
        <li>開催6日前以降：返金はありませんが、次回開催へ1回振替できます</li>
        <li>当日の欠席・無連絡：返金・振替の対象外です</li>
        <li>主催者都合で中止する場合：全額返金します</li>
      </ul>
      <p>ご不明な点は、このメールへ返信してください。<br>当日お会いできることを楽しみにしています。</p>
      <p>私会議<br>企画・運営：エーテル</p>
    </div>
  `;

  const resendResponse = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `watashi-kaigi/participant-confirmation/${checkoutSessionId}`,
    },
    body: JSON.stringify({
      from,
      to: [participantEmail],
      reply_to: organizerEmail,
      subject,
      text,
      html,
    }),
  });

  let resendPayload;
  try {
    resendPayload = await resendResponse.json();
  } catch {
    resendPayload = {};
  }

  if (!resendResponse.ok || !resendPayload.id) {
    const errorMessage = asString(resendPayload.message) || `HTTP ${resendResponse.status}`;
    await env.DB.prepare(`
      UPDATE registrations
      SET participant_email_last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE checkout_session_id = ?
    `).bind(errorMessage.slice(0, 500), checkoutSessionId).run();
    throw new Error(`Participant confirmation failed: ${errorMessage}`);
  }

  const sentAt = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE registrations
    SET
      participant_email_sent_at = ?,
      participant_email_message_id = ?,
      participant_email_last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE checkout_session_id = ?
  `).bind(sentAt, resendPayload.id, checkoutSessionId).run();

  console.log(JSON.stringify({
    event: "participant_confirmation_sent",
    checkout_session_id: checkoutSessionId,
    resend_message_id: resendPayload.id,
  }));

  return { sent: true, messageId: resendPayload.id };
}

export async function authenticateAdminRequest(request, env) {
  if (env.ADMIN_LOCAL_BYPASS === "true") {
    return { email: "local-admin" };
  }

  const teamDomain = asString(env.TEAM_DOMAIN).replace(/\/+$/, "");
  const policyAudience = asString(env.POLICY_AUD);
  const token = request.headers.get("cf-access-jwt-assertion") || "";

  if (!teamDomain || !policyAudience || !token) return null;

  try {
    const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience: policyAudience,
    });
    const email = asString(payload.email);
    return email ? { email } : null;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "admin_access_token_invalid",
      error: error instanceof Error ? error.message : "Unknown error",
    }));
    return null;
  }
}

export async function getAdminRegistrations(env) {
  if (!env.DB) throw new Error("D1 database binding is missing");

  const [summary, registrations] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN payment_status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE
          WHEN organizer_email_last_error IS NOT NULL
            OR participant_email_last_error IS NOT NULL
          THEN 1 ELSE 0
        END) AS notification_errors
      FROM registrations
    `).first(),
    env.DB.prepare(`
      SELECT
        order_id,
        checkout_session_id,
        payment_status,
        amount_total,
        currency,
        participant_name,
        participant_email,
        participant_tel,
        event_id,
        event_date,
        ai_experience,
        paid_at,
        created_at,
        organizer_email_sent_at,
        organizer_email_message_id,
        organizer_email_last_error,
        participant_email_sent_at,
        participant_email_message_id,
        participant_email_last_error
      FROM registrations
      ORDER BY created_at DESC
      LIMIT 200
    `).all(),
  ]);

  return {
    summary: {
      total: Number(summary?.total || 0),
      paid: Number(summary?.paid || 0),
      failed: Number(summary?.failed || 0),
      notificationErrors: Number(summary?.notification_errors || 0),
    },
    registrations: registrations.results || [],
  };
}

async function handleAdminRequest(request, env) {
  const admin = await authenticateAdminRequest(request, env);
  if (!admin) {
    return adminJsonResponse({ error: "管理画面へのアクセス権限を確認できません。" }, 403);
  }

  const url = new URL(request.url);
  if (url.pathname === "/admin/api/registrations") {
    if (request.method !== "GET") {
      return adminJsonResponse({ error: "この操作にはGETリクエストが必要です。" }, 405);
    }

    const data = await getAdminRegistrations(env);
    return adminJsonResponse({
      ...data,
      viewer: admin.email,
      generatedAt: new Date().toISOString(),
    });
  }

  if (url.pathname.startsWith("/admin/api/")) {
    return adminJsonResponse({ error: "管理APIが見つかりません。" }, 404);
  }

  const assetResponse = await env.ASSETS.fetch(request);
  const response = new Response(assetResponse.body, assetResponse);
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("content-security-policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/admin") {
      return Response.redirect(`${url.origin}/admin/`, 302);
    }

    if (url.pathname.startsWith("/admin/")) {
      try {
        return await handleAdminRequest(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "admin_request_error", error: error.message }));
        return adminJsonResponse({ error: "管理データを取得できませんでした。" }, 500);
      }
    }

    if (url.pathname === "/api/stripe-webhook") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "この操作にはPOSTリクエストが必要です。" }, 405);
      }

      try {
        return await handleStripeWebhook(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "stripe_webhook_error", error: error.message }));
        return jsonResponse({ error: "Webhookの処理中に問題が発生しました。" }, 500);
      }
    }

    if (url.pathname === "/api/create-checkout-session") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "この操作にはPOSTリクエストが必要です。" }, 405);
      }

      try {
        return await createCheckoutSession(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "checkout_unhandled_error", error: error.message }));
        return jsonResponse({ error: "決済ページの準備中に問題が発生しました。" }, 500);
      }
    }

    if (url.pathname === "/api/event-status") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "この操作にはGETリクエストが必要です。" }, 405);
      }

      try {
        return jsonResponse(await getEventAvailability(env));
      } catch (error) {
        console.error(JSON.stringify({ event: "event_status_error", error: error.message }));
        return jsonResponse({ error: "空席状況を取得できませんでした。" }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "APIが見つかりません。" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
