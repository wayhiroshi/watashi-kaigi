import assert from "node:assert/strict";
import test from "node:test";

import worker, { getAdminRegistrations } from "../src/worker.js";

function createAdminDb() {
  const summary = { total: 2, paid: 1, failed: 1, notification_errors: 1 };
  const registrations = [{
    order_id: "order-1",
    participant_name: "Test Participant",
    participant_email: "participant@example.com",
    payment_status: "paid",
  }];

  return {
    prepare(sql) {
      return {
        async first() {
          assert.match(sql, /COUNT\(\*\)/);
          return summary;
        },
        async all() {
          assert.match(sql, /FROM registrations/);
          return { results: registrations };
        },
      };
    },
  };
}

test("returns an admin summary and registration rows", async () => {
  const result = await getAdminRegistrations({ DB: createAdminDb() });
  assert.deepEqual(result.summary, {
    total: 2,
    paid: 1,
    failed: 1,
    notificationErrors: 1,
  });
  assert.equal(result.registrations[0].participant_email, "participant@example.com");
});

test("allows local admin API access for preview", async () => {
  const request = new Request("http://127.0.0.1/admin/api/registrations");
  const response = await worker.fetch(request, {
    DB: createAdminDb(),
    ADMIN_LOCAL_BYPASS: "true",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.viewer, "local-admin");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(payload.summary.total, 2);
});

test("denies production admin API requests without an Access JWT", async () => {
  const request = new Request("https://watashi-kaigi.aether42.com/admin/api/registrations");
  const response = await worker.fetch(request, { DB: createAdminDb() });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "管理画面へのアクセス権限を確認できません。",
  });
});
