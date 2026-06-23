const form = document.getElementById("entryForm");
const modal = document.getElementById("thanksModal");
const mailtoLink = document.getElementById("mailtoLink");
const OWNER_EMAIL = "way.hiroshi.66@gmail.com";

function setError(name, message) {
  const target = document.querySelector(`[data-error-for="${name}"]`);
  if (target) target.textContent = message || "";
}
function clearErrors() {
  document.querySelectorAll(".error-message").forEach((el) => { el.textContent = ""; });
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
document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearErrors();

  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const email = String(data.get("email") || "").trim();
  const agree = data.get("agree") === "on";
  let hasError = false;

  if (!name) { setError("name", "お名前を入力してください。"); hasError = true; }
  if (!email) {
    setError("email", "メールアドレスを入力してください。"); hasError = true;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setError("email", "メールアドレスの形式をご確認ください。"); hasError = true;
  }
  if (!agree) { setError("agree", "同意にチェックを入れてください。"); hasError = true; }
  if (hasError) return;

  const subject = encodeURIComponent("【参加申込】AIで考える、これからの私会議");
  const body = encodeURIComponent([
    "AIで考える、これからの私会議 参加申し込み",
    "",
    "【お名前】", name,
    "",
    "【メールアドレス】", email,
    "",
    "【電話番号】", String(data.get("tel") || "未入力"),
    "",
    "【参加希望日】", String(data.get("date") || "未選択"),
    "",
    "【AIの利用経験】", String(data.get("aiExperience") || "未選択")
  ].join("\n"));
  const mailto = `mailto:${OWNER_EMAIL}?subject=${subject}&body=${body}`;
  openModal(mailto);
  window.location.href = mailto;
});