/**
 * Welcome Mat client — autonomous agent enrollment via DPoP (RFC 9449)
 * Spec: https://github.com/solpbc/welcome-mat/raw/refs/heads/main/spec.md
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function jsonB64url(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf as BufferSource));
}

async function sha1(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", buf as BufferSource));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomJti(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

// ── JWK thumbprint per RFC 7638 ───────────────────────────────────────────────

async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  let canonical: string;
  if (jwk.kty === "EC") {
    // EC: { crv, kty, x, y } in lex order
    canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  } else {
    // RSA: { e, kty, n } in lex order
    canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  }
  return b64url(await sha256(canonical));
}

// ── keypair ───────────────────────────────────────────────────────────────────

export interface AgentKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  alg: string;
}

export async function generateKeypair(alg = "ES256"): Promise<AgentKey> {
  if (alg.startsWith("ES")) {
    const crv = alg === "ES256" ? "P-256" : alg === "ES384" ? "P-384" : "P-521";
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: crv },
      true,
      ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    return { privateKey: pair.privateKey, alg, publicJwk };
  }
  if (alg.startsWith("RS") || alg.startsWith("PS")) {
    const bits = alg === "RS256" || alg === "PS256" ? 4096 : 4096;
    const hash = alg.endsWith("256")
      ? "SHA-256"
      : alg.endsWith("384")
      ? "SHA-384"
      : "SHA-512";
    const name = alg.startsWith("PS") ? "RSA-PSS" : "RSASSA-PKCS1-v1_5";
    const pair = await crypto.subtle.generateKey(
      {
        name,
        modulusLength: bits,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash,
      },
      true,
      ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    return { privateKey: pair.privateKey, alg, publicJwk };
  }
  throw new Error(`Unsupported alg: ${alg}`);
}

// ── JWT signing ───────────────────────────────────────────────────────────────

function signingParams(alg: string): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  if (alg.startsWith("ES")) return { name: "ECDSA", hash: "SHA-256" } as EcdsaParams;
  if (alg.startsWith("PS")) {
    const saltLen = alg === "PS256" ? 32 : alg === "PS384" ? 48 : 64;
    return { name: "RSA-PSS", saltLength: saltLen } as RsaPssParams;
  }
  // RS*
  return { name: "RSASSA-PKCS1-v1_5" };
}

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  alg: string,
): Promise<string> {
  const input = `${jsonB64url(header)}.${jsonB64url(payload)}`;
  const sig = await crypto.subtle.sign(
    signingParams(alg),
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(sig)}`;
}

// ── welcome.md parser ─────────────────────────────────────────────────────────

interface WelcomeMeta {
  tosUrl: string;
  signupUrl: string;
  algorithms: string[];
}

function parseWelcomeMd(md: string): WelcomeMeta {
  // Extract ToS URL
  const tosMatch =
    md.match(/terms[^:\n]*:\s*GET\s+(https?:\/\/\S+)/i) ||
    md.match(/GET\s+(https?:\/\/[^\s`]+tos[^\s`]*)/i) ||
    md.match(/`(https?:\/\/[^`\s]+tos[^`\s]*)`/i) ||
    md.match(/terms[^:\n]*:\s*(https?:\/\/\S+)/i);
  const signupMatch =
    md.match(/signup[^:\n]*:\s*POST\s+(https?:\/\/\S+)/i) ||
    md.match(/POST\s+(https?:\/\/[^\s`]+signup[^\s`]*)/i) ||
    md.match(/`(https?:\/\/[^`\s]+signup[^`\s]*)`/i) ||
    md.match(/signup[^:\n]*:\s*(https?:\/\/\S+)/i);
  const algMatch = [
    ...md.matchAll(/\b(ES256|ES384|ES512|RS256|RS384|RS512|PS256)\b/g),
  ].map((m) => m[1]);

  if (!tosMatch) throw new Error("welcome.md: cannot find ToS URL");
  if (!signupMatch) throw new Error("welcome.md: cannot find signup URL");

  return {
    tosUrl: tosMatch[1],
    signupUrl: signupMatch[1],
    algorithms: [...new Set(algMatch.length ? algMatch : ["ES256"])],
  };
}

// ── DPoP proof ────────────────────────────────────────────────────────────────

async function makeDpopProof(opts: {
  method: string;
  url: string;
  key: AgentKey;
  accessToken?: string;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    jti: randomJti(),
    htm: opts.method.toUpperCase(),
    htu: opts.url.split("?")[0].split("#")[0],
    iat: Math.floor(Date.now() / 1000),
  };
  if (opts.accessToken) {
    payload.ath = b64url(await sha256(opts.accessToken));
  }
  return signJwt(
    { typ: "dpop+jwt", alg: opts.key.alg, jwk: opts.key.publicJwk },
    payload,
    opts.key.privateKey,
    opts.key.alg,
  );
}

// ── enrollment ────────────────────────────────────────────────────────────────

export interface EnrollmentResult {
  accessToken: string;
  key: AgentKey;
  meta: WelcomeMeta;
  origin: string;
  /** SHA1 of the ToS text — usable as actx seed for RBAC sub construction */
  tosHash256: string;
}

export async function enroll(
  serviceOrigin: string,
  extraFields: Record<string, unknown> = {},
): Promise<EnrollmentResult> {
  const origin = serviceOrigin.replace(/\/$/, "");

  // 1. Discover
  const welcomeRes = await fetch(`${origin}/.well-known/welcome.md`);
  if (!welcomeRes.ok) throw new Error(`welcome.md fetch failed: ${welcomeRes.status}`);
  const welcomeMd = await welcomeRes.text();
  const meta = parseWelcomeMd(welcomeMd);

  // 2. Keypair (use first advertised algorithm)
  const key = await generateKeypair(meta.algorithms[0]);

  // 3. Fetch ToS
  const tosRes = await fetch(meta.tosUrl);
  if (!tosRes.ok) throw new Error(`ToS fetch failed: ${tosRes.status}`);
  const tosText = await tosRes.text();

  // 4. Sign ToS raw bytes
  const tosSig = await crypto.subtle.sign(
    signingParams(key.alg),
    key.privateKey,
    new TextEncoder().encode(tosText),
  );

  // 5. Self-signed access token (wm+jwt)
  const tosHash256 = b64url(await sha256(tosText));
  const jkt = await jwkThumbprint(key.publicJwk);
  const accessToken = await signJwt(
    { typ: "wm+jwt", alg: key.alg },
    {
      jti: randomJti(),
      tos_hash: tosHash256,
      aud: origin,
      cnf: { jkt },
      iat: Math.floor(Date.now() / 1000),
    },
    key.privateKey,
    key.alg,
  );

  // 6. POST signup with DPoP proof (no ath on signup per spec)
  const dpop = await makeDpopProof({ method: "POST", url: meta.signupUrl, key });

  const signupRes = await fetch(meta.signupUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", DPoP: dpop },
    body: JSON.stringify({
      tos_signature: b64url(tosSig),
      access_token: accessToken,
      ...extraFields,
    }),
  });

  if (!signupRes.ok) {
    const body = await signupRes.text();
    throw new Error(`Signup failed ${signupRes.status}: ${body}`);
  }

  const signupBody = await signupRes.json();
  const finalToken: string = signupBody.access_token ?? accessToken;

  return { accessToken: finalToken, key, meta, origin, tosHash256 };
}

// ── module-level enrolled client store ───────────────────────────────────────
// Keyed by service origin (lowercase). Persists for the lifetime of the process
// so the LLM can call create_record_on_enrolled_account after enrollment.

export const enrolledClients = new Map<string, WelcomeMatClient>();

// ── authenticated client ──────────────────────────────────────────────────────

export class WelcomeMatClient {
  accessToken: string;
  key: AgentKey;
  meta: WelcomeMeta;
  origin: string;
  private extraFields: Record<string, unknown>;

  private constructor(
    enrollment: EnrollmentResult,
    extraFields: Record<string, unknown>,
  ) {
    this.accessToken = enrollment.accessToken;
    this.key = enrollment.key;
    this.meta = enrollment.meta;
    this.origin = enrollment.origin;
    this.extraFields = extraFields;
  }

  static async connect(
    serviceOrigin: string,
    extraFields: Record<string, unknown> = {},
  ): Promise<WelcomeMatClient> {
    const enrollment = await enroll(serviceOrigin, extraFields);
    const client = new WelcomeMatClient(enrollment, extraFields);
    enrolledClients.set(serviceOrigin.replace(/\/$/, "").toLowerCase(), client);
    return client;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.origin}${path}`;
    const method = (init.method ?? "GET").toUpperCase();

    const dpop = await makeDpopProof({
      method,
      url,
      key: this.key,
      accessToken: this.accessToken,
    });

    const res = await fetch(url, {
      ...init,
      method,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `DPoP ${this.accessToken}`,
        DPoP: dpop,
      },
    });

    // Re-consent on tos_changed
    if (res.status === 401) {
      const body = await res.clone().json().catch(() => ({}));
      if ((body as Record<string, unknown>)?.error === "tos_changed") {
        const enrollment = await enroll(this.origin, this.extraFields);
        this.accessToken = enrollment.accessToken;
        this.key = enrollment.key;
        enrolledClients.set(this.origin.toLowerCase(), this);
        return this.fetch(path, init);
      }
    }

    return res;
  }

  /**
   * Create an ATProto record on this account's PDS using DPoP auth.
   * Calls /xrpc/com.atproto.repo.createRecord on the service origin.
   */
  async createRecord(
    repo: string,
    collection: string,
    record: Record<string, unknown>,
  ): Promise<{ uri: string; cid: string }> {
    const res = await this.fetch("/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, collection, record }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`createRecord failed ${res.status}: ${text}`);
    }
    return res.json();
  }
}

// ── actx helper ───────────────────────────────────────────────────────────────

/**
 * Compute the actx value used in RBAC sub fields.
 * actx = SHA1 of the accept record URI (at://...) as a hex string.
 * This matches what the droplet-oidc service uses when issuing workload tokens.
 */
export async function computeActx(acceptUri: string): Promise<string> {
  return sha1(acceptUri);
}
