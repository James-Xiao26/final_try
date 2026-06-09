import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, createRateLimiter, isHoneypotTripped, isValidEmail } from "./waitlist";

// --- isValidEmail -----------------------------------------------------------

test("isValidEmail accepts well-formed addresses (trimming surrounding space)", () => {
  assert.equal(isValidEmail("user@example.com"), true);
  assert.equal(isValidEmail("  user@example.com  "), true);
  assert.equal(isValidEmail("a.b+tag@sub.domain.io"), true);
});

test("isValidEmail rejects junk and non-strings", () => {
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail("missing@domain"), false); // no dotted TLD
  assert.equal(isValidEmail("@example.com"), false);
  assert.equal(isValidEmail("spaces in@example.com"), false);
  assert.equal(isValidEmail(""), false);
  assert.equal(isValidEmail(undefined), false);
  assert.equal(isValidEmail(42), false);
});

// --- isHoneypotTripped ------------------------------------------------------

test("isHoneypotTripped is true only for a non-empty string", () => {
  assert.equal(isHoneypotTripped("acme corp"), true);
  assert.equal(isHoneypotTripped("   "), false); // whitespace-only counts as empty
  assert.equal(isHoneypotTripped(""), false);
  assert.equal(isHoneypotTripped(undefined), false);
  assert.equal(isHoneypotTripped(null), false);
  assert.equal(isHoneypotTripped(123), false);
});

// --- clientIp ---------------------------------------------------------------

function request(headers: Record<string, string>): Request {
  return new Request("https://edgeboard.test/api/waitlist", { method: "POST", headers });
}

test("clientIp takes the first hop of x-forwarded-for", () => {
  assert.equal(clientIp(request({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" })), "203.0.113.7");
});

test("clientIp falls back to x-real-ip, then 'unknown'", () => {
  assert.equal(clientIp(request({ "x-real-ip": "198.51.100.5" })), "198.51.100.5");
  assert.equal(clientIp(request({})), "unknown");
});

// --- createRateLimiter ------------------------------------------------------

test("createRateLimiter allows up to maxRequests, then throttles", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3 });
  assert.equal(limiter.check("ip"), false);
  assert.equal(limiter.check("ip"), false);
  assert.equal(limiter.check("ip"), false);
  assert.equal(limiter.check("ip"), true); // 4th within the window is blocked
  assert.equal(limiter.check("ip"), true);
});

test("createRateLimiter tracks each key independently", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
  assert.equal(limiter.check("a"), false);
  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("b"), false); // a different IP has its own budget
});

test("createRateLimiter forgets hits once they fall outside the window", () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({ windowMs: 1_000, maxRequests: 1, now: () => now });
  assert.equal(limiter.check("ip"), false);
  assert.equal(limiter.check("ip"), true); // still inside the 1s window
  now += 1_001; // advance past the window
  assert.equal(limiter.check("ip"), false); // the earlier hit has expired
});
