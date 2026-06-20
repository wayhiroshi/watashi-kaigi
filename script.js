const form = document.getElementById("entryForm");
const modal = document.getElementById("thanksModal");
const mailtoLink = document.getElementById("mailtoLink");

// 申込を受け取りたいメールアドレスに変更してください
const OWNER_EMAIL = "way.hiroshi.66@gmail.com";

function setError(name, message) {
  const target = document.querySelector(`[data-error-for="${name}"]`);
  if (target) target.textContent = message || "";
}
function clearErrors() {
  document.querySelectorAll(".error-message").forEach((el) => { el.textContent = ""; });
}
function getCheckedValues(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((input) => input.value);
}
function buildMailBody(data) {
  return [
    "AIで考える、これからの私会議 参加申し込み",
    "",
    "【お名前】", data.name,
    "",
    "【メールアドレス】", data.email,
    "",
    "【電話番号】", data.tel || "未入力",
    "",
    "【年代】", data.age || "未選択",
    "",
    "【AI利用経験】", data.aiExperience || "未選択",
    "",
    "【気になっているテーマ】", data.themes.length ? data.themes.join("、") : "未選択",
    "",
    "【メッセージ・ご質問】", data.message || "未入力",
    "",
    "----",
    "このメールは申込ページのフォームから作成されました。"
  ].join("\n");
}
function openModal(mailto) {
  mailtoLink.href = mailto;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}
function closeModal() {
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}
document.querySelectorAll("[data-close-modal]").forEach((button) => {
  button.addEventListener("click", closeModal);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearErrors();

  const formData = new FormData(form);
  const data = {
    name: String(formData.get("name") || "").trim(),
    email: String(formData.get("email") || "").trim(),
    tel: String(formData.get("tel") || "").trim(),
    age: String(formData.get("age") || "").trim(),
    aiExperience: String(formData.get("aiExperience") || "").trim(),
    themes: getCheckedValues("theme"),
    message: String(formData.get("message") || "").trim(),
    agree: formData.get("agree") === "on"
  };

  let hasError = false;
  if (!data.name) { setError("name", "お名前を入力してください。"); hasError = true; }
  if (!data.email) {
    setError("email", "メールアドレスを入力してください。"); hasError = true;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    setError("email", "メールアドレスの形式をご確認ください。"); hasError = true;
  }
  if (!data.agree) { setError("agree", "同意にチェックを入れてください。"); hasError = true; }
  if (hasError) return;

  const subject = encodeURIComponent("【参加申込】AIで考える、これからの私会議");
  const body = encodeURIComponent(buildMailBody(data));
  const mailto = `mailto:${OWNER_EMAIL}?subject=${subject}&body=${body}`;

  openModal(mailto);
  window.location.href = mailto;
});