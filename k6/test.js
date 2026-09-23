import http from "k6/http";
import { check, sleep } from "k6";
import { generateJwtFromPrivateJwk } from "./jwt-utils.js";
// TODO: setup to test http -> https redirects
const SERVICE_1_BASE_URL =
  __ENV.SERVICE_1_BASE_URL || "https://service-1.desafio-devops.local";
const SERVICE_3_BASE_URL =
  __ENV.SERVICE_3_BASE_URL || "https://service-3.desafio-devops.local";
const PRIVATE_JWK_FILE =
  __ENV.PRIVATE_JWK_FILE || "../fake-vault/jwt/private.dec.jwk";
const JWT_ISSUER = __ENV.JWT_ISSUER || "https://desafio-devops.local";
const JWT_SUBJECT = __ENV.JWT_SUBJECT || "demo-user";
const JWT_AUDIENCE_SERVICE_1 = __ENV.JWT_AUDIENCE_SERVICE_1 || "service-1";
const JWT_AUDIENCE_SERVICE_3 = __ENV.JWT_AUDIENCE_SERVICE_3 || "service-3";
const JWT_AUDIENCES = __ENV.JWT_AUDIENCES || [
  JWT_AUDIENCE_SERVICE_1,
  JWT_AUDIENCE_SERVICE_3,
];
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
const SERVICE_2_URL = `${SERVICE_1_BASE_URL}/service-2`;
const SERVICE_3_URL = `${SERVICE_3_BASE_URL}/service-3`;
const PATH_SUFFIXES = ["", "/service-1", "/service-2", "/service-3"];

function requestOptions(token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return { headers };
}

function runJwtMatrixChecks({
  label,
  url,
  validJwt,
  forbiddenJwt,
  invalidJwt,
  swappedAudienceJwt,
  validJwtExpectedStatus,
}) {
  const PAD_LENGTH = 40;
  const noTokenResponse = http.get(url, requestOptions());
  check(noTokenResponse, {
    [`JWT(exists=N valid=x aud=x); ${label.padEnd(PAD_LENGTH, " ")}; -> 403`]: (
      r,
    ) => r.status === 403,
  });

  const invalidTokenResponse = http.get(url, requestOptions(invalidJwt));
  check(invalidTokenResponse, {
    [`JWT(exists=Y valid=N aud=x); ${label.padEnd(PAD_LENGTH, " ")}; -> 401`]: (
      r,
    ) => r.status === 401,
  });

  if (forbiddenJwt) {
    const forbiddenTokenResponse = http.get(url, requestOptions(forbiddenJwt));
    check(forbiddenTokenResponse, {
      [`JWT(forbidden=Y); ${label.padEnd(PAD_LENGTH, " ")}; -> 403`]: (r) =>
        r.status === 403,
    });
  }

  if (validJwt) {
    const validTokenResponse = http.get(url, requestOptions(validJwt));
    check(validTokenResponse, {
      [`JWT(exists=Y valid=Y aud=Y); ${label.padEnd(PAD_LENGTH, " ")}; -> ${validJwtExpectedStatus}`]:
        (r) => r.status === validJwtExpectedStatus,
    });
  }

  if (swappedAudienceJwt) {
    const swappedAudienceResponse = http.get(
      url,
      requestOptions(swappedAudienceJwt),
    );
    check(swappedAudienceResponse, {
      [`JWT(exists=Y valid=Y aud=N); ${label.padEnd(PAD_LENGTH, " ")}; -> 403`]:
        (r) => r.status === 403,
    });
  }
}

export const options = {
  stages: [
    {
      duration: "1m",
      target: 30,
    },
    {
      duration: "10m",
      target: 30,
    },
    {
      duration: "5m",
      target: 0,
    },
  ],
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
      "INSECURE_SKIP_TLS_VERIFY=true. TLS certificate verification is disabled. See https://github.com/grafana/k6/issues/218#issuecomment-301486668.",
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

  const pathTestTargets = [
    {
      label: "GW=1->SVC=1",
      serviceName: "service-1",
      baseUrl: SERVICE_1_URL,
      swappedAudienceJwt: service3AudienceJwt,
    },
    {
      label: "GW=1->SVC=2",
      serviceName: "service-2",
      baseUrl: SERVICE_2_URL,
      swappedAudienceJwt: service3AudienceJwt,
    },
    {
      label: "GW=3->SVC=3",
      serviceName: "service-3",
      baseUrl: SERVICE_3_URL,
      swappedAudienceJwt: service1AudienceJwt,
    },
    // {
    //   label: "GW=1->SVC=1->SVC=2",
    //   serviceName: "service-1-2",
    //   baseUrl: `${SERVICE_1_URL}/service-2`,
    //   swappedAudienceJwt: service3AudienceJwt,
    // },
  ];

  for (const target of pathTestTargets) {
    for (const pathSuffix of PATH_SUFFIXES) {
      if (pathSuffix === `/${target.serviceName}`) {
        continue;
      }

      const validJwtExpectedStatus =
        (target.serviceName === "service-1" && pathSuffix === "/service-2") ||
        (target.serviceName !== "service-2" && pathSuffix === "/")
          ? 200
          : 403;

      // if (validJwtExpectedStatus !== 200) {continue}; // only OK!

      runJwtMatrixChecks({
        label: `${target.label} path=${pathSuffix}`,
        url: `${target.baseUrl}${pathSuffix}`,
        validJwt: runtimeValidJwt,
        forbiddenJwt: FORBIDDEN_JWT,
        invalidJwt: INVALID_JWT,
        swappedAudienceJwt: target.swappedAudienceJwt,
        validJwtExpectedStatus,
      });
    }
  }

  sleep(1);
}
