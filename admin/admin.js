const state = { registrations: [] };

const elements = {
  failed: document.querySelector("#failed-count"),
  message: document.querySelector("#message"),
  notificationErrors: document.querySelector("#notification-error-count"),
  paid: document.querySelector("#paid-count"),
  refresh: document.querySelector("#refresh"),
  rows: document.querySelector("#registration-rows"),
  search: document.querySelector("#search"),
  status: document.querySelector("#status-filter"),
  tableWrap: document.querySelector("#table-wrap"),
  total: document.querySelector("#total-count"),
  updatedAt: document.querySelector("#updated-at"),
  viewer: document.querySelector("#viewer"),
};

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value.endsWith?.("Z") ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAmount(value, currency) {
  if (!Number.isInteger(value)) return "-";
  if (String(currency).toLowerCase() === "jpy") return `${value.toLocaleString("ja-JP")}円`;
  return `${value} ${String(currency || "").toUpperCase()}`.trim();
}

function statusLabel(status) {
  return { paid: "決済完了", failed: "決済失敗", unpaid: "未払い" }[status] || status || "不明";
}

function appendText(parent, className, text) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
}

function createStatus(text, className) {
  const element = document.createElement("span");
  element.className = `status ${className}`;
  element.textContent = text;
  return element;
}

function createRow(registration) {
  const row = document.createElement("tr");
  const participant = document.createElement("td");
  appendText(participant, "primary", registration.participant_name || "未入力");
  appendText(participant, "secondary", registration.ai_experience || "AI経験未選択");

  const contact = document.createElement("td");
  appendText(contact, "primary", registration.participant_email || "-");
  appendText(contact, "secondary", registration.participant_tel || "電話番号未入力");

  const eventDate = document.createElement("td");
  eventDate.textContent = registration.event_date || "未選択";

  const payment = document.createElement("td");
  payment.append(createStatus(statusLabel(registration.payment_status), registration.payment_status));
  appendText(payment, "secondary", formatAmount(registration.amount_total, registration.currency));

  const notification = document.createElement("td");
  if (registration.organizer_email_last_error) {
    notification.append(createStatus("送信エラー", "error"));
    appendText(notification, "secondary", registration.organizer_email_last_error);
  } else if (registration.organizer_email_sent_at) {
    notification.append(createStatus("送信済み", "sent"));
    appendText(notification, "secondary", formatDate(registration.organizer_email_sent_at));
  } else {
    notification.append(createStatus("未送信", "pending"));
  }

  const createdAt = document.createElement("td");
  createdAt.textContent = formatDate(registration.created_at);
  row.append(participant, contact, eventDate, payment, notification, createdAt);
  return row;
}

function renderRows() {
  const query = elements.search.value.trim().toLowerCase();
  const status = elements.status.value;
  const filtered = state.registrations.filter((registration) => {
    const matchesStatus = status === "all" || registration.payment_status === status;
    const haystack = [
      registration.participant_name,
      registration.participant_email,
      registration.participant_tel,
    ].join(" ").toLowerCase();
    return matchesStatus && (!query || haystack.includes(query));
  });

  elements.rows.replaceChildren(...filtered.map(createRow));
  elements.tableWrap.hidden = filtered.length === 0;
  elements.message.hidden = filtered.length > 0;
  if (filtered.length === 0) {
    elements.message.classList.remove("error");
    elements.message.textContent = state.registrations.length === 0
      ? "申込はまだありません。"
      : "条件に一致する申込はありません。";
  }
}

async function loadRegistrations() {
  elements.refresh.disabled = true;
  elements.message.hidden = false;
  elements.message.classList.remove("error");
  elements.message.textContent = "読み込み中...";

  try {
    const response = await fetch("/admin/api/registrations", {
      headers: { accept: "application/json" },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "管理データを取得できませんでした。");

    state.registrations = payload.registrations;
    elements.total.textContent = payload.summary.total.toLocaleString("ja-JP");
    elements.paid.textContent = payload.summary.paid.toLocaleString("ja-JP");
    elements.failed.textContent = payload.summary.failed.toLocaleString("ja-JP");
    elements.notificationErrors.textContent = payload.summary.notificationErrors.toLocaleString("ja-JP");
    elements.viewer.textContent = payload.viewer;
    elements.updatedAt.textContent = `更新 ${formatDate(payload.generatedAt)}`;
    renderRows();
  } catch (error) {
    elements.tableWrap.hidden = true;
    elements.message.hidden = false;
    elements.message.classList.add("error");
    elements.message.textContent = error.message;
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener("click", loadRegistrations);
elements.search.addEventListener("input", renderRows);
elements.status.addEventListener("change", renderRows);
loadRegistrations();
