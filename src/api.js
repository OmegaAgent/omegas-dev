const DEVICE_HEADER = "x-omega-device-token";
export const PRODUCTION_API_ORIGIN = "https://api.omegas.dev";
export const PRODUCTION_APP_ORIGIN = "https://omegas.dev";
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function validateApiBase(baseUrl, unsafeDevelopmentApi = false) {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("API URL must be an origin without credentials, path, query, or fragment");
  }
  if (!unsafeDevelopmentApi && url.origin !== PRODUCTION_API_ORIGIN) {
    throw new Error(`release builds upload only to ${PRODUCTION_API_ORIGIN}`);
  }
  if (url.protocol !== "https:" && !(unsafeDevelopmentApi && url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("API URL must use HTTPS (HTTP is allowed only for an explicit loopback development API)");
  }
  return url.origin;
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: "error" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 413) {
      throw new Error(
        "The normalized transfer exceeded Omegas' upload limit. Nothing was uploaded. " +
        "Update omegas-dev and retry; if it still fails, scan narrower roots with --root.",
      );
    }
    throw new Error(body.error || `API request failed with HTTP ${response.status}`);
  }
  return body;
}

export function createApiClient(baseUrl, { unsafeDevelopmentApi = false } = {}) {
  const base = validateApiBase(baseUrl, unsafeDevelopmentApi);
  return {
    start() {
      return requestJson(`${base}/api/onboarding/local-transfers`, { method: "POST" });
    },
    status(transferId, deviceToken) {
      return requestJson(`${base}/api/onboarding/local-transfers/${transferId}`, {
        headers: { [DEVICE_HEADER]: deviceToken },
      });
    },
    upload(transferId, deviceToken, payload) {
      const body = JSON.stringify(payload);
      const uploadBytes = new TextEncoder().encode(body).byteLength;
      if (uploadBytes > MAX_UPLOAD_BYTES) {
        throw new Error(
          `The normalized transfer is ${(uploadBytes / (1024 * 1024)).toFixed(1)} MB, above ` +
          "Omegas' 10 MB upload limit. Nothing was uploaded. Update omegas-dev and retry; " +
          "if it still fails, scan narrower roots with --root.",
        );
      }
      return requestJson(`${base}/api/onboarding/local-transfers/${transferId}/payload`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [DEVICE_HEADER]: deviceToken,
        },
        body,
      });
    },
  };
}

export function validateVerificationUrl(raw, unsafeDevelopmentApi = false) {
  const url = new URL(raw);
  if (!unsafeDevelopmentApi && url.origin !== PRODUCTION_APP_ORIGIN) {
    throw new Error(`unexpected verification origin: ${url.origin}`);
  }
  if (url.protocol !== "https:" && !(unsafeDevelopmentApi && url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("verification URL must use HTTPS or explicit loopback development HTTP");
  }
  if (url.pathname !== "/onboarding/local-transfer") {
    throw new Error("unexpected verification path");
  }
  return url.toString();
}

export async function waitForClaim(api, session, { intervalMs = 2000, onTick = () => {} } = {}) {
  const deadline = new Date(session.expires_at).getTime();
  while (Date.now() < deadline) {
    const status = await api.status(session.transfer_id, session.device_token);
    if (status.status === "claimed") return status;
    if (status.status === "uploaded") return status;
    if (status.status === "expired" || status.status === "cancelled") {
      throw new Error(`transfer ${status.status}`);
    }
    onTick(status);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("transfer expired before the browser claimed it");
}
