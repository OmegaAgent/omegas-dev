import assert from "node:assert/strict";
import test from "node:test";
import {
  createApiClient,
  MAX_UPLOAD_BYTES,
  PRODUCTION_API_ORIGIN,
  validateApiBase,
  validateVerificationUrl,
} from "../src/api.js";

test("release uploads are pinned to the Omegas production API", () => {
  assert.equal(validateApiBase(PRODUCTION_API_ORIGIN), PRODUCTION_API_ORIGIN);
  assert.throws(() => validateApiBase("https://example.com"), /release builds upload only/);
  assert.throws(() => validateApiBase("https://api.omegas.dev/other"), /must be an origin/);
  assert.throws(() => validateApiBase("https://user:pass@api.omegas.dev"), /without credentials/);
});

test("development HTTP is explicit and loopback only", () => {
  assert.equal(
    validateApiBase("http://127.0.0.1:8080", true),
    "http://127.0.0.1:8080",
  );
  assert.throws(() => validateApiBase("http://example.com", true), /must use HTTPS/);
});

test("claim links are pinned to the expected production path", () => {
  assert.equal(
    validateVerificationUrl("https://omegas.dev/onboarding/local-transfer"),
    "https://omegas.dev/onboarding/local-transfer",
  );
  assert.throws(
    () => validateVerificationUrl("https://example.com/onboarding/local-transfer"),
    /unexpected verification origin/,
  );
  assert.throws(
    () => validateVerificationUrl("https://omegas.dev/sign-in"),
    /unexpected verification path/,
  );
});

test("refuses an oversized normalized transfer before making a request", () => {
  const api = createApiClient(PRODUCTION_API_ORIGIN);
  const oversized = { content: "x".repeat(MAX_UPLOAD_BYTES) };
  assert.throws(
    () => api.upload("transfer", "device", oversized),
    /above Omegas' 10 MB upload limit.*Nothing was uploaded/,
  );
});

test("turns an API 413 into an actionable retry message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 413,
    json: async () => ({}),
  });
  try {
    const api = createApiClient(PRODUCTION_API_ORIGIN);
    await assert.rejects(
      api.upload("transfer", "device", { content: "small" }),
      /exceeded Omegas' upload limit.*Nothing was uploaded/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
