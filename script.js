const form = document.getElementById("entryForm");
const modal = document.getElementById("thanksModal");
const modalTitle = document.getElementById("thanksTitle");
const modalMessage = document.getElementById("thanksMessage");
const checkoutLink = document.getElementById("checkoutLink");
const submitButton = form.querySelector('button[type="submit"]');
const CHECKOUT_ENDPOINT = "/api/create-checkout-session";
const DEFAULT_BUTTON_TEXT = submitButton.textContent;

function setError(name, message) {
  const target = document.querySelector(`[data-error-for="${name}"]`);
  if (target) target.textContent = message || "";
}
function clearErrors() {
  document.querySelectorAll(".error-message").forEach((el) => { el.textContent = ""; });
}
function openModal({ title, message, href, linkText }) {
  modalTitle.textContent = title;
  modalMessage.textContent = message;
  checkoutLink.textContent = linkText;
  checkoutLink.href = href;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}
function closeModal() {
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}
function setSubmitting(isSubmitting) {
  submitButton.disabled = isSubmitting;
  submitButton.textContent = isSubmitting ? "決済ページを準備しています..." : DEFAULT_BUTTON_TEXT;
}
function getPayload(data) {
  return {
    name: String(data.get("name") || "").trim(),
    email: String(data.get("email") || "").trim(),
    tel: String(data.get("tel") || "").trim(),
    date: String(data.get("date") || "").trim(),
    aiExperience: String(data.get("aiExperience") || "").trim(),
    agree: data.get("agree") === "on",
  };
}
document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

const paymentStatus = new URLSearchParams(window.location.search).get("payment");
if (paymentStatus === "success") {
  openModal({
    title: "決済を受け付けました",
    message: "Stripeから決済確認メールが届きます。開催詳細は主催者よりあらためてご連絡します。",
    href: "#entry",
    linkText: "申し込み欄に戻る",
  });
} else if (paymentStatus === "cancelled") {
  setError("form", "決済は完了していません。内容をご確認のうえ、もう一度お試しください。");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearErrors();

  const data = new FormData(form);
  const payload = getPayload(data);
  let hasError = false;

  if (!payload.name) { setError("name", "お名前を入力してください。"); hasError = true; }
  if (!payload.email) {
    setError("email", "メールアドレスを入力してください。"); hasError = true;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    setError("email", "メールアドレスの形式をご確認ください。"); hasError = true;
  }
  if (!payload.agree) { setError("agree", "同意にチェックを入れてください。"); hasError = true; }
  if (hasError) return;

  setSubmitting(true);

  try {
    const response = await fetch(CHECKOUT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) {
      throw new Error(result.error || "決済ページを準備できませんでした。");
    }

    openModal({
      title: "Stripe決済ページへ移動します",
      message: "決済ページを開いています。自動で移動しない場合は、下のボタンからお進みください。",
      href: result.url,
      linkText: "決済ページを開く",
    });
    window.location.assign(result.url);
  } catch (error) {
    setError("form", error.message || "決済ページの準備中に問題が発生しました。");
    setSubmitting(false);
  }
});
