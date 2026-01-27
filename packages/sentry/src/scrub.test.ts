import { describe, expect, it } from "vitest";
import {
  isSensitiveKey,
  SENSITIVE_KEYS,
  SENSITIVE_PATTERNS,
  scrubObject,
  scrubString,
  scrubStringNullable,
} from "./scrub.js";

describe("scrubString", () => {
  describe("auth tokens and credentials", () => {
    it("scrubs token= patterns", () => {
      expect(scrubString("token=abc123xyz")).toBe("[REDACTED]");
      expect(scrubString("url?token=secret&foo=bar")).toBe(
        "url?[REDACTED]&foo=bar"
      );
    });

    it("scrubs api_key= patterns", () => {
      expect(scrubString("api_key=sk_test_123")).toBe("[REDACTED]");
      expect(scrubString("apikey=mykey")).toBe("[REDACTED]");
      expect(scrubString("api-key=mykey")).toBe("[REDACTED]");
    });

    it("scrubs password= patterns", () => {
      expect(scrubString("password=hunter2")).toBe("[REDACTED]");
    });

    it("scrubs secret= patterns", () => {
      expect(scrubString("secret=verysecret")).toBe("[REDACTED]");
    });

    it("scrubs Bearer tokens", () => {
      expect(scrubString("Authorization: Bearer eyJhbGc...")).toBe(
        "Authorization: [REDACTED]"
      );
      expect(scrubString("bearer token123")).toBe("[REDACTED]");
    });

    it("scrubs session_id patterns", () => {
      expect(scrubString("session_id=abc123")).toBe("[REDACTED]");
      expect(scrubString("sessionid=xyz")).toBe("[REDACTED]");
    });

    it("scrubs access_token patterns", () => {
      expect(scrubString("access_token=tok123")).toBe("[REDACTED]");
      expect(scrubString("accesstoken=tok456")).toBe("[REDACTED]");
    });

    it("scrubs refresh_token patterns", () => {
      expect(scrubString("refresh_token=ref123")).toBe("[REDACTED]");
    });

    it("scrubs OAuth codes (20+ chars)", () => {
      expect(scrubString("code=abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED]");
      // Short codes should not be scrubbed
      expect(scrubString("code=short")).toBe("code=short");
    });
  });

  describe("URL credentials", () => {
    it("scrubs basic auth in URLs", () => {
      expect(scrubString("http://user:password@example.com/path")).toBe(
        "http[REDACTED]example.com/path"
      );
      expect(scrubString("https://admin:secret123@api.service.com")).toBe(
        "https[REDACTED]api.service.com"
      );
    });
  });

  describe("JWT tokens", () => {
    it("scrubs JWT tokens", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      // JWT is detected and scrubbed (note: "token:" also matched as a separate pattern)
      expect(scrubString(`Authorization: ${jwt}`)).toBe(
        "Authorization: [REDACTED]"
      );
      expect(scrubString(jwt)).toBe("[REDACTED]");
    });
  });

  describe("service-specific tokens", () => {
    it("scrubs GitHub tokens", () => {
      expect(scrubString("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
      expect(scrubString("gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
      expect(scrubString("ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
      expect(scrubString("ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
      expect(scrubString("ghr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
    });

    it("scrubs Stripe keys", () => {
      expect(scrubString("sk_live_xxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
      expect(scrubString("pk_live_xxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
      expect(scrubString("sk_test_xxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
      expect(scrubString("pk_test_xxxxxxxxxxxxxxxxxxxxxxxx")).toContain(
        "[REDACTED]"
      );
    });

    it("scrubs AWS access key IDs", () => {
      expect(scrubString("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
    });
  });

  describe("private keys", () => {
    it("scrubs private key markers", () => {
      expect(scrubString("-----BEGIN PRIVATE KEY-----")).toBe("[REDACTED]");
      expect(scrubString("-----BEGIN RSA PRIVATE KEY-----")).toBe("[REDACTED]");
    });
  });

  describe("PII patterns", () => {
    it("scrubs email addresses", () => {
      expect(scrubString("contact: user@example.com")).toBe(
        "contact: [REDACTED]"
      );
      expect(scrubString("email=test.user+tag@subdomain.example.co.uk")).toBe(
        "email=[REDACTED]"
      );
    });

    it("scrubs credit card numbers", () => {
      expect(scrubString("card: 4111111111111111")).toBe("card: [REDACTED]");
      expect(scrubString("card: 4111-1111-1111-1111")).toBe("card: [REDACTED]");
      expect(scrubString("card: 4111 1111 1111 1111")).toBe("card: [REDACTED]");
    });

    it("scrubs SSN patterns (US format)", () => {
      expect(scrubString("ssn: 123-45-6789")).toBe("ssn: [REDACTED]");
    });

    it("scrubs US/Canadian phone numbers", () => {
      expect(scrubString("phone: 555-123-4567")).toBe("phone: [REDACTED]");
      expect(scrubString("phone: (555) 123-4567")).toBe("phone: [REDACTED]");
      expect(scrubString("phone: +1 555-123-4567")).toBe("phone: [REDACTED]");
      expect(scrubString("phone: 1-555-123-4567")).toBe("phone: [REDACTED]");
    });

    it("scrubs international phone numbers", () => {
      // UK format
      expect(scrubString("phone: +44 20 7946 0958")).toBe("phone: [REDACTED]");
      // German format
      expect(scrubString("phone: +49 30 12345678")).toBe("phone: [REDACTED]");
      // E.164 format
      expect(scrubString("phone: +442079460958")).toBe("phone: [REDACTED]");
    });
  });

  describe("edge cases", () => {
    it("handles empty strings", () => {
      expect(scrubString("")).toBe("");
    });

    it("handles strings with no sensitive data", () => {
      expect(scrubString("Hello, world!")).toBe("Hello, world!");
    });

    it("handles multiple sensitive patterns in one string", () => {
      const input = "token=abc password=xyz email@test.com";
      const result = scrubString(input);
      expect(result).not.toContain("abc");
      expect(result).not.toContain("xyz");
      expect(result).not.toContain("email@test.com");
    });

    it("is case insensitive for keywords", () => {
      expect(scrubString("TOKEN=secret")).toBe("[REDACTED]");
      expect(scrubString("Password=hunter2")).toBe("[REDACTED]");
      expect(scrubString("BEARER token123")).toBe("[REDACTED]");
    });

    it("handles repeated calls correctly (lastIndex reset)", () => {
      // Ensures the /g flag lastIndex is reset between calls
      const result1 = scrubString("token=abc");
      const result2 = scrubString("token=xyz");
      expect(result1).toBe("[REDACTED]");
      expect(result2).toBe("[REDACTED]");
    });
  });
});

describe("scrubStringNullable", () => {
  it("returns undefined for null", () => {
    expect(scrubStringNullable(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(scrubStringNullable(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(scrubStringNullable("")).toBeUndefined();
  });

  it("scrubs non-empty strings", () => {
    expect(scrubStringNullable("token=secret")).toBe("[REDACTED]");
    expect(scrubStringNullable("safe text")).toBe("safe text");
  });
});

describe("isSensitiveKey", () => {
  it("detects sensitive keys", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("api-key")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("jwt")).toBe(true);
    expect(isSensitiveKey("privateKey")).toBe(true);
    expect(isSensitiveKey("private_key")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isSensitiveKey("PASSWORD")).toBe(true);
    expect(isSensitiveKey("ApiKey")).toBe(true);
    expect(isSensitiveKey("AUTHORIZATION")).toBe(true);
  });

  it("returns false for non-sensitive keys", () => {
    expect(isSensitiveKey("username")).toBe(false);
    expect(isSensitiveKey("email")).toBe(false);
    expect(isSensitiveKey("id")).toBe(false);
    expect(isSensitiveKey("name")).toBe(false);
  });
});

describe("scrubObject", () => {
  it("redacts values for sensitive keys", () => {
    const obj = {
      username: "john",
      password: "secret123",
      api_key: "key123",
    };
    const result = scrubObject(obj);
    expect(result.username).toBe("john");
    expect(result.password).toBe("[REDACTED]");
    expect(result.api_key).toBe("[REDACTED]");
  });

  it("scrubs sensitive patterns in string values", () => {
    const obj = {
      message: "user token=abc123 logged in",
      email: "Contact at user@example.com",
    };
    const result = scrubObject(obj);
    expect(result.message).toBe("user [REDACTED] logged in");
    expect(result.email).toBe("Contact at [REDACTED]");
  });

  it("recursively scrubs nested objects", () => {
    const obj = {
      user: {
        name: "john",
        credentials: {
          password: "secret",
          token: "tok123",
        },
      },
    };
    const result = scrubObject(obj);
    expect((result.user as Record<string, unknown>).name).toBe("john");
    expect(
      (
        (result.user as Record<string, unknown>).credentials as Record<
          string,
          unknown
        >
      ).password
    ).toBe("[REDACTED]");
    expect(
      (
        (result.user as Record<string, unknown>).credentials as Record<
          string,
          unknown
        >
      ).token
    ).toBe("[REDACTED]");
  });

  it("scrubs arrays", () => {
    const obj = {
      items: ["safe", "token=secret", "also safe"],
    };
    const result = scrubObject(obj);
    expect(result.items).toEqual(["safe", "[REDACTED]", "also safe"]);
  });

  it("handles nested arrays", () => {
    const obj = {
      data: [["safe", "password=test"], ["another"]],
    };
    const result = scrubObject(obj);
    expect(result.data).toEqual([["safe", "[REDACTED]"], ["another"]]);
  });

  it("preserves non-string, non-object values", () => {
    const obj = {
      count: 42,
      active: true,
      empty: null,
    };
    const result = scrubObject(obj);
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.empty).toBe(null);
  });

  describe("circular references", () => {
    it("detects and handles circular references in objects", () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj;
      const result = scrubObject(obj);
      expect(result.name).toBe("test");
      expect(result.self).toEqual({ "[CIRCULAR]": true });
    });

    it("detects and handles circular references in arrays", () => {
      const arr: unknown[] = ["item"];
      arr.push(arr);
      const obj = { data: arr };
      const result = scrubObject(obj);
      expect((result.data as unknown[])[0]).toBe("item");
      expect((result.data as unknown[])[1]).toEqual(["[CIRCULAR]"]);
    });
  });

  describe("depth limits", () => {
    it("truncates at maximum depth", () => {
      // Create an object nested 25 levels deep (max is 20)
      // MAX_DEPTH is 20, truncation happens when depth > 20 (at depth 21)
      let obj: Record<string, unknown> = { value: "deep" };
      for (let i = 0; i < 25; i++) {
        obj = { nested: obj };
      }
      const result = scrubObject(obj);

      // Navigate down to depth 20 (valid), then check depth 21 (truncated)
      let current: Record<string, unknown> = result;
      for (let i = 0; i < 20; i++) {
        expect(current.nested).toBeDefined();
        current = current.nested as Record<string, unknown>;
      }
      // At depth 20, still valid. The nested property at depth 21 is truncated.
      const truncated = current.nested as Record<string, unknown>;
      expect(truncated["[TRUNCATED]"]).toBe("max depth exceeded");
    });
  });
});

describe("SENSITIVE_PATTERNS", () => {
  it("exports an array of regex patterns", () => {
    expect(Array.isArray(SENSITIVE_PATTERNS)).toBe(true);
    expect(SENSITIVE_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });

  it("all patterns have global flag", () => {
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(pattern.flags).toContain("g");
    }
  });
});

describe("SENSITIVE_KEYS", () => {
  it("exports a Set of sensitive key names", () => {
    expect(SENSITIVE_KEYS).toBeInstanceOf(Set);
    expect(SENSITIVE_KEYS.size).toBeGreaterThan(0);
  });

  it("contains expected sensitive keys", () => {
    expect(SENSITIVE_KEYS.has("token")).toBe(true);
    expect(SENSITIVE_KEYS.has("password")).toBe(true);
    expect(SENSITIVE_KEYS.has("secret")).toBe(true);
    expect(SENSITIVE_KEYS.has("apikey")).toBe(true);
    expect(SENSITIVE_KEYS.has("authorization")).toBe(true);
  });
});
