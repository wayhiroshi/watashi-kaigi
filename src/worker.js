const STRIPE_API_VERSION = "2026-06-24.dahlia";
const STRIPE_CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
const EVENT_NAME = "AIで考える、これからの私会議 参加費";
const EVENT_PRICE_JPY = 3000;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
