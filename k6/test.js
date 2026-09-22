import http from "k6/http";
import { check, sleep } from "k6";
import { generateJwtFromPrivateJwk } from "./jwt-utils.js";
// TODO: setup to test http -> https redirects
const SERVICE_1_BASE_URL =
  __ENV.SERVICE_1_BASE_URL ||
  __ENV.BASE_URL ||
  "https://service-1.desafio-devops.local";
const SERVICE_3_BASE_URL =
  __ENV.SERVICE_3_BASE_URL || "https://service-3.desafio-devops.local";
const PRIVATE_JWK_FILE =
  __ENV.PRIVATE_JWK_FILE || "../fake-vault/jwt/private.dec.jwk";
const JWT_ISSUER = __ENV.JWT_ISSUER || "https://desafio-devops.local";
const JWT_SUBJECT = __ENV.JWT_SUBJECT || "demo-user";
const JWT_AUDIENCE_SERVICE_1 = __ENV.JWT_AUDIENCE_SERVICE_1 || "service-1";
const JWT_AUDIENCE_SERVICE_3 = __ENV.JWT_AUDIENCE_SERVICE_3 || "service-3";
const JWT_AUDIENCES = (__ENV.JWT_AUDIENCES || "service-1,service-3")
  .split(",")
  .map((aud) => aud.trim())
  .filter(Boolean);

const VALID_JWT_FILE = __ENV.VALID_JWT_FILE || "";

function getToken({ value, filePath }) {
  if (value) {
    return value.trim();
  }

  if (!filePath) {
    return "";
  }

  try {
    return open(filePath).trim();
  } catch (_) {
    return "";
  }
}

const VALID_JWT = getToken({
  value: __ENV.VALID_JWT || "",
  filePath: VALID_JWT_FILE,
});

const PRIVATE_JWK = getToken({
  value: __ENV.PRIVATE_JWK || "",
  filePath: PRIVATE_JWK_FILE,
});

const FORBIDDEN_JWT = getToken({
  value: __ENV.FORBIDDEN_JWT || "",
  filePath: __ENV.FORBIDDEN_JWT_FILE || "",
});

const INVALID_JWT =
  __ENV.INVALID_JWT || "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.";
const INSECURE_SKIP_TLS_VERIFY =
  (__ENV.INSECURE_SKIP_TLS_VERIFY || "true").toLowerCase() === "true";

const SERVICE_1_URL = `${SERVICE_1_BASE_URL}/service-1`;
const SERVICE_3_URL = `${SERVICE_3_BASE_URL}/service-3`;
const SERVICE_2_ROUTE_ROOT_URL = `${SERVICE_1_BASE_URL}/service-2`;

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
  insecureSkipTLSVerify: INSECURE_SKIP_TLS_VERIFY,
};

export async function setup() {
  let validJwt = VALID_JWT;
  let service1AudienceJwt = "";
  let service3AudienceJwt = "";

  try {
    const privateJwk = PRIVATE_JWK;

    if (!privateJwk) {
      throw new Error(
        "PRIVATE_JWK is empty. Set PRIVATE_JWK or PRIVATE_JWK_FILE.",
      );
    }

    if (!validJwt) {
      validJwt = await generateJwtFromPrivateJwk(privateJwk, {
        issuer: JWT_ISSUER,
        subject: JWT_SUBJECT,
        audiences: JWT_AUDIENCES,
      });
      console.warn("VALID_JWT was generated on the fly with encodeJwt.");
    }

    service1AudienceJwt = await generateJwtFromPrivateJwk(privateJwk, {
      issuer: JWT_ISSUER,
      subject: JWT_SUBJECT,
      audiences: [JWT_AUDIENCE_SERVICE_1],
    });

    service3AudienceJwt = await generateJwtFromPrivateJwk(privateJwk, {
      issuer: JWT_ISSUER,
      subject: JWT_SUBJECT,
      audiences: [JWT_AUDIENCE_SERVICE_3],
    });
  } catch (err) {
    console.warn(`JWTs could not be generated on the fly: ${String(err)}`);
  }

  if (!validJwt) {
    console.warn(
      "VALID_JWT is not set. The valid-token checks will fail with 401 until a signed JWT is provided.",
    );
  }

  if (INSECURE_SKIP_TLS_VERIFY) {
    console.warn(
      "INSECURE_SKIP_TLS_VERIFY=true. TLS certificate verification is disabled.",
    );
  }
  if (!FORBIDDEN_JWT) {
    console.warn(
      "FORBIDDEN_JWT is not set. The forbidden-token checks (expected 403) will be skipped.",
    );
  }

  return {
    validJwt,
    service1AudienceJwt,
    service3AudienceJwt,
  };
}

export default function (data) {
  const runtimeValidJwt = data && data.validJwt ? data.validJwt : "";
  const service1AudienceJwt =
    data && data.service1AudienceJwt ? data.service1AudienceJwt : "";
  const service3AudienceJwt =
    data && data.service3AudienceJwt ? data.service3AudienceJwt : "";

  const noTokenService1 = http.get(SERVICE_1_URL, requestOptions());
  check(noTokenService1, {
    "service-1 without JWT -> 403": (r) => r.status === 403,
  });

  const invalidTokenService1 = http.get(
    SERVICE_1_URL,
    requestOptions(INVALID_JWT),
  );
  check(invalidTokenService1, {
    "service-1 with invalid JWT -> 401": (r) => r.status === 401,
  });

  if (FORBIDDEN_JWT) {
    const forbiddenTokenService1 = http.get(
      SERVICE_1_URL,
      requestOptions(FORBIDDEN_JWT),
    );
    check(forbiddenTokenService1, {
      "service-1 with forbidden JWT -> 403": (r) => r.status === 403,
    });
  }

  if (runtimeValidJwt) {
    const validTokenService1 = http.get(
      SERVICE_1_URL,
      requestOptions(runtimeValidJwt),
    );
    check(validTokenService1, {
      "service-1 with valid JWT -> 200": (r) => r.status === 200,
    });
  }

  if (service3AudienceJwt) {
    const swappedAudienceOnService1 = http.get(
      SERVICE_1_URL,
      requestOptions(service3AudienceJwt),
    );
    check(swappedAudienceOnService1, {
      "service-1 with swapped audience token (aud=service-3) -> 403": (r) =>
        r.status === 403,
    });
  }

  const service2RootNoToken = http.get(
    SERVICE_2_ROUTE_ROOT_URL,
    requestOptions(),
  );
  check(service2RootNoToken, {
    "service-1 domain route /service-2 without JWT -> 403": (r) =>
      r.status === 403,
  });

  if (runtimeValidJwt) {
    const service2RootValidToken = http.get(
      SERVICE_2_ROUTE_ROOT_URL,
      requestOptions(runtimeValidJwt),
    );
    check(service2RootValidToken, {
      "service-1 domain route /service-2 with valid JWT -> 403": (r) =>
        r.status === 403,
    });
  }

  const noTokenService3 = http.get(SERVICE_3_URL, requestOptions());
  check(noTokenService3, {
    "service-3 without JWT -> 403": (r) => r.status === 403,
  });

  const invalidTokenService3 = http.get(
    SERVICE_3_URL,
    requestOptions(INVALID_JWT),
  );
  check(invalidTokenService3, {
    "service-3 with invalid JWT -> 401": (r) => r.status === 401,
  });

  if (FORBIDDEN_JWT) {
    const forbiddenTokenService3 = http.get(
      SERVICE_3_URL,
      requestOptions(FORBIDDEN_JWT),
    );
    check(forbiddenTokenService3, {
      "service-3 with forbidden JWT -> 403": (r) => r.status === 403,
    });
  }

  if (runtimeValidJwt) {
    const validTokenService3 = http.get(
      SERVICE_3_URL,
      requestOptions(runtimeValidJwt),
    );
    check(validTokenService3, {
      "service-3 with valid JWT -> 200": (r) => r.status === 200,
    });
  }

  if (service1AudienceJwt) {
    const swappedAudienceOnService3 = http.get(
      SERVICE_3_URL,
      requestOptions(service1AudienceJwt),
    );
    check(swappedAudienceOnService3, {
      "service-3 with swapped audience token (aud=service-1) -> 403": (r) =>
        r.status === 403,
    });
  }

  sleep(1);
}
