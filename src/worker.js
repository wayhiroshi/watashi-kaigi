const STRIPE_API_VERSION = "2026-06-24.dahlia";
const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
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
    stripeEvent.type === "checkout.session.completed"
    || stripeEvent.type === "checkout.session.async_payment_succeeded"
  ) {
    console.log(JSON.stringify({ ...logPayload, event: "stripe_checkout_paid" }));
  } else if (stripeEvent.type === "checkout.session.async_payment_failed") {
    console.warn(JSON.stringify({ ...logPayload, event: "stripe_checkout_payment_failed" }));
  } else {
    console.log(JSON.stringify(logPayload));
  }

  return jsonResponse({ received: true });
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
