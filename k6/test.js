import http from "k6/http";
import { check, sleep } from "k6";
// TODO: setup to test http -> https redirects
// TODO: there are 2 gateways to test service-(1|3).desafio-devops.local
// TODO: auto generate JWTs from /fake-vault/jwt/private.dec.jwks
const BASE_URL = __ENV.BASE_URL || "https://service-1.desafio-devops.local";
const VALID_JWT = __ENV.VALID_JWT || "";
const INVALID_JWT =
  __ENV.INVALID_JWT || "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.";

const SERVICE_1_URL = `${BASE_URL}/service-1`;
const SERVICE_3_URL = `${BASE_URL}/service-3`;

function requestOptions(token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return { headers };
}

export const options = {
  vus: 1,
  duration: "30s",
};

export function setup() {
  if (!VALID_JWT) {
    console.warn(
      "VALID_JWT is not set. The valid-token checks will fail with 401 until a signed JWT is provided.",
    );
  }
}

export default function () {
  const noTokenService1 = http.get(SERVICE_1_URL, requestOptions());
  check(noTokenService1, {
    "service-1 without JWT -> 401": (r) => r.status === 401,
  });

  const invalidTokenService1 = http.get(
    SERVICE_1_URL,
    requestOptions(INVALID_JWT),
  );
  check(invalidTokenService1, {
    "service-1 with invalid JWT -> 401": (r) => r.status === 401,
  });

  if (VALID_JWT) {
    const validTokenService1 = http.get(
      SERVICE_1_URL,
      requestOptions(VALID_JWT),
    );
    check(validTokenService1, {
      "service-1 with valid JWT -> 200": (r) => r.status === 200,
    });
  }

  const noTokenService3 = http.get(SERVICE_3_URL, requestOptions());
  check(noTokenService3, {
    "service-3 without JWT -> 401": (r) => r.status === 401,
  });

  const invalidTokenService3 = http.get(
    SERVICE_3_URL,
    requestOptions(INVALID_JWT),
  );
  check(invalidTokenService3, {
    "service-3 with invalid JWT -> 401": (r) => r.status === 401,
  });

  if (VALID_JWT) {
    const validTokenService3 = http.get(
      SERVICE_3_URL,
      requestOptions(VALID_JWT),
    );
    check(validTokenService3, {
      "service-3 with valid JWT -> 200": (r) => r.status === 200,
    });
  }

  sleep(1);
}
