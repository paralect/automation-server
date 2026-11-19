import { describe, expect, test } from "bun:test";

import { clipForRedaction, redactText, redactUntrusted, redactUrl, stripQuery } from "../src/redact";

describe("redactText", () => {
  const cases: [string, string, string][] = [
    ["email", "contact jane.doe+x@example.co.uk now", "contact [email] now"],
    ["ipv4", "from 192.168.1.20:8080 failed", "from [ip]:8080 failed"],
    ["ipv6 full", "peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 gone", "peer [ip] gone"],
    ["ipv6 compressed", "peer fe80::1ff:fe23:4567:890a gone", "peer [ip] gone"],
    ["ipv6 loopback", "bind ::1 ok", "bind [ip] ok"],
    ["jwt", "t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF_123-x end", "t [redacted] end"],
    ["bearer", "Authorization failed for Bearer abc.def-123", "Authorization failed for Bearer [redacted]"],
    ["header line", "GET /x\nAuthorization: Basic dXNlcjpwYXNz\nHost: a", "GET /x\nAuthorization: [redacted]\nHost: a"],
    ["cookie header", "Cookie: sid=1; other=2", "Cookie: [redacted]"],
    ["set-cookie header", "set-cookie: a=b; Path=/", "set-cookie: [redacted]"],
    ["key=value", "login password=hunter2 ok", "login password=[redacted] ok"],
    ["api_key", "api_key=sk_live_x&b=1", "api_key=[redacted]&b=1"],
    ["json", '{"password":"p w","name":"bob"}', '{"password":"[redacted]","name":"bob"}'],
    ["json spaced", `{"api-key": "zzz", "x": 1}`, `{"api-key": "[redacted]", "x": 1}`],
    ["suffix key", "access_token: abc123", "access_token: [redacted]"],
    ["hex token", "id 0123456789abcdef0123456789abcdef end", "id [redacted] end"],
    ["mixed token", "k Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZg end", "k [redacted] end"],
    ["card spaced", "card 4242 4242 4242 4242 declined", "card [card] declined"],
    ["card plain", "paid with 5555555555554444.", "paid with [card]."],
    ["phone international", "call me at +44 20 7946 0958 please", "call me at [phone] please"],
    ["phone e164", "whatsapp +14155552671", "whatsapp [phone]"],
    ["phone local", "my number is (415) 555-2671 or 415.555.2671", "my number is [phone] or [phone]"],
    ["url query", "GET https://a.com/p/q?id=7&email=x end", "GET https://a.com/p/q?[redacted] end"],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => expect(redactText(input)).toBe(expected));
  }

  test("is idempotent", () => {
    for (const [, input] of cases) {
      const once = redactText(input);
      expect(redactText(once)).toBe(once);
    }
  });

  describe("false positives", () => {
    const keep = [
      "at handler (src/components/UserList.tsx:42:13)",
      "/Users/dev/projects/app/node_modules/some-package/dist/index.js",
      "node_modules/@sentry/browser/esm/helpers.js",
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "web@1.2.3",
      "v10.0.1",
      "Foo::bar failed",
      "std::vector<int>",
      "at 12:30:45 today",
      "someVeryLongDescriptiveFunctionNameWithoutAnyDigitsAtAll",
      "handle_request_for_the_account_settings_page_v2",
      "https://example.com/docs/page",
      "999.1.1.1 is not an ip",
      "1.2.3.4.5",
      "Unexpected token < in JSON at position 0",
      "order 1234567890123 shipped",
      "2026-01-01T00:00:00Z",
      "2026-01-01 00:00:00",
      "Sentry Issue: 1117540176",
      "version 2026.11.16",
      "math 3 + 4 = 7",
    ];
    for (const s of keep) test(s, () => expect(redactText(s)).toBe(s));
  });

  test("a valid four-part dotted number is treated as an IPv4 address", () => {
    expect(redactText("release 1.2.3.4")).toBe("release [ip]");
  });
});

describe("url helpers", () => {
  test("stripQuery cuts query and fragment", () => {
    expect(stripQuery("https://a.com/x?y=1#z")).toBe("https://a.com/x");
    expect(stripQuery("/plain")).toBe("/plain");
  });
  test("redactUrl", () => {
    expect(redactUrl("https://a.com/u/jane@x.com?token=1")).toBe("https://a.com/u/[email]");
  });
});

describe("untrusted input", () => {
  test("short text is redacted exactly like redactText", () => {
    const text = "mail ada@example.com token=abc123secret";
    expect(redactUntrusted(text)).toBe(redactText(text));
    expect(clipForRedaction(text)).toBe(text);
  });

  test("long text is cut at the cap and a trailing partial token is dropped", () => {
    const clipped = clipForRedaction(`${"hello ".repeat(663)}${"x".repeat(1)}ghp_partialtokenthatwas`, 4000);
    expect(clipped.length).toBeLessThanOrEqual(4000);
    expect(clipped).not.toContain("ghp_");
    expect(clipForRedaction("a".repeat(200_000))).toHaveLength(4000);
  });

  test("hostile long inputs finish quickly", () => {
    for (const text of ["a".repeat(200_000), "token".repeat(40_000), `${"a".repeat(100_000)}@${"b".repeat(100_000)}`, "a=".repeat(100_000)]) {
      const started = performance.now();
      redactUntrusted(text);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});
