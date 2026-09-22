import encoding from "k6/encoding";

function string2ArrayBuffer(str) {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

function readDerLength(bytes, offset) {
  const first = bytes[offset];
  if ((first & 0x80) === 0) {
    return { len: first, nextOffset: offset + 1 };
  }

  const octets = first & 0x7f;
  let len = 0;
  for (let i = 0; i < octets; i++) {
    len = (len << 8) | bytes[offset + 1 + i];
  }

  return { len, nextOffset: offset + 1 + octets };
}

function normalizeInt(bytes, size) {
  let intBytes = bytes;
  while (intBytes.length > 0 && intBytes[0] === 0) {
    intBytes = intBytes.slice(1);
  }

  if (intBytes.length > size) {
    throw new Error("ECDSA component is larger than expected");
  }

  const output = new Uint8Array(size);
  output.set(intBytes, size - intBytes.length);
  return output;
}

function derToJose(signatureBuffer, size) {
  const bytes = new Uint8Array(signatureBuffer);

  // Some runtimes already return JOSE-style raw R||S signatures.
  if (bytes.length === size * 2 && bytes[0] !== 0x30) {
    return signatureBuffer;
  }

  let offset = 0;

  if (bytes[offset++] !== 0x30) {
    throw new Error("Invalid DER signature sequence");
  }

  const seqLenInfo = readDerLength(bytes, offset);
  offset = seqLenInfo.nextOffset;

  if (bytes[offset++] !== 0x02) {
    throw new Error("Invalid DER signature R marker");
  }

  const rLenInfo = readDerLength(bytes, offset);
  offset = rLenInfo.nextOffset;
  const r = bytes.slice(offset, offset + rLenInfo.len);
  offset += rLenInfo.len;

  if (bytes[offset++] !== 0x02) {
    throw new Error("Invalid DER signature S marker");
  }

  const sLenInfo = readDerLength(bytes, offset);
  offset = sLenInfo.nextOffset;
  const s = bytes.slice(offset, offset + sLenInfo.len);

  const rPadded = normalizeInt(r, size);
  const sPadded = normalizeInt(s, size);

  const jose = new Uint8Array(size * 2);
  jose.set(rPadded, 0);
  jose.set(sPadded, size);

  return jose.buffer;
}

export async function encodeJwt(header, payload, key) {
  const headerString = encoding.b64encode(JSON.stringify(header), "rawurl");
  const payloadString = encoding.b64encode(JSON.stringify(payload), "rawurl");

  const signatureBuffer = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    key,
    string2ArrayBuffer([headerString, payloadString].join(".")),
  );

  const joseSignature = derToJose(signatureBuffer, 32);
  const signature = encoding.b64encode(joseSignature, "rawurl");

  return [headerString, payloadString, signature].join(".");
}

export async function generateJwtFromPrivateJwk(privateJwkJson, options) {
  const jwk = JSON.parse(privateJwkJson);
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: jwk.alg || "ES256",
    kid: jwk.kid,
    typ: "JWT",
  };

  const payload = {
    iss: options.issuer,
    sub: options.subject,
    aud: options.audiences,
    iat: now,
    nbf: now,
    exp: now + 86400,
  };

  return encodeJwt(header, payload, signingKey);
}
