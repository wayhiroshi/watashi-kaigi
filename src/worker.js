const STRIPE_API_VERSION = "2026-06-24.dahlia";
const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const EVENT_NAME = "AIで考える、これからの私会議 参加費";
const EVENT_PRICE_JPY = 3000;
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
  const date = asString(payload.date) || "未選択";
  const aiExperience = asString(payload.aiExperience) || "未選択";
  const agree = payload.agree === true;

  if (!name) return { error: "お名前を入力してください。" };
  if (!email) return { error: "メールアドレスを入力してください。" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "メールアドレスの形式をご確認ください。" };
  }
  if (!agree) return { error: "同意にチェックを入れてください。" };

  return { value: { name, email, tel, date, aiExperience } };
}

function appendMetadata(params, prefix, metadata) {
  Object.entries(metadata).forEach(([key, value]) => {
    params.set(`${prefix}[${key}]`, truncateMetadata(value));
  });
}

async function createCheckoutSession(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(
      { error: "Stripeの秘密鍵が設定されていません。" },
      500,
    );
  }

  let payload;
  try {
    payload = await readJson(request);
  } catch (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  const validation = validateCheckoutPayload(payload);
  if (validation.error) return jsonResponse({ error: validation.error }, 400);

  const { name, email, tel, date, aiExperience } = validation.value;
  const baseUrl = getBaseUrl(request, env);
  const orderId = crypto.randomUUID();
  const metadata = {
    order_id: orderId,
    name,
    email,
    tel: tel || "未入力",
    date,
    ai_experience: aiExperience,
  };

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("locale", "ja");
  params.set("submit_type", "pay");
  params.set("customer_email", email);
  params.set("client_reference_id", orderId);
  params.set("success_url", `${baseUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}#entry`);
  params.set("cancel_url", `${baseUrl}/?payment=cancelled#entry`);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "jpy");
  params.set("line_items[0][price_data][unit_amount]", String(EVENT_PRICE_JPY));
  params.set("line_items[0][price_data][product_data][name]", EVENT_NAME);
  params.set(
    "custom_text[submit][message]",
    "決済完了後、主催者より開催詳細をご連絡します。",
  );
  appendMetadata(params, "metadata", metadata);
  appendMetadata(params, "payment_intent_data[metadata]", metadata);

  const stripeResponse = await fetch(STRIPE_CHECKOUT_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_API_VERSION,
    },
    body: params,
  });

  let stripePayload;
  try {
    stripePayload = await stripeResponse.json();
  } catch (error) {
    console.error(JSON.stringify({ event: "stripe_invalid_json", error: error.message }));
    return jsonResponse({ error: "Stripeからの応答を確認できませんでした。" }, 502);
  }

  if (!stripeResponse.ok || !stripePayload.url) {
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

  if (isCheckoutEvent) {
    await saveRegistration(env, stripeEvent, session);

    if (
      stripeEvent.type === "checkout.session.async_payment_succeeded"
      || (
        stripeEvent.type === "checkout.session.completed"
        && session.payment_status === "paid"
      )
    ) {
      await sendOrganizerNotification(env, stripeEvent, session);
    }
  }

  const logPayload = {
    event: "stripe_webhook_received",
    stripe_event_id: stripeEvent.id,
    stripe_event_type: stripeEvent.type,
    checkout_session_id: session.id,
    payment_status: session.payment_status,
    order_id: session.client_reference_id || session.metadata?.order_id,
    customer_email: session.customer_details?.email || session.customer_email,
    participant_name: session.metadata?.name,
    event_date: session.metadata?.date,
  };

  if (
    stripeEvent.type === "checkout.session.async_payment_succeeded"
    || (
      stripeEvent.type === "checkout.session.completed"
      && session.payment_status === "paid"
    )
  ) {
    console.log(JSON.stringify({ ...logPayload, event: "stripe_checkout_paid" }));
  } else if (stripeEvent.type === "checkout.session.async_payment_failed") {
    console.warn(JSON.stringify({ ...logPayload, event: "stripe_checkout_payment_failed" }));
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkout_session_id) DO UPDATE SET
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "APIが見つかりません。" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
