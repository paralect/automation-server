const REDACTED = "[redacted]";

const SENSITIVE_KEY = "[\\w-]*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|session)[\\w-]*";

const HEADER_LINE = /^([ \t]*)(authorization|proxy-authorization|cookie|set-cookie)[ \t]*:.*$/gim;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
const BEARER = /\bBearer[ \t]+[^\s"']+/gi;
const KEY_VALUE = new RegExp(
  `(["']?${SENSITIVE_KEY}["']?[ \\t]*[:=][ \\t]*)(\\[redacted\\]|"[^"\\n]*"|'[^'\\n]*'|[^\\s,&;"'}\\]]+)`,
  "gi",
);
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4 = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/g;
const H = "[0-9a-f]{1,4}";
const IPV6 = new RegExp(
  `(?<![\\w:])(?:(?:${H}:){7}${H}|(?:${H}(?::${H}){0,6})?::(?:${H}(?::${H}){0,6})?)(?![\\w:])`,
  "gi",
);
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const PHONE_INTL = /(?<![\w+])\+\d[\d ().-]{6,18}\d(?!\w)/g;
const PHONE_LOCAL = /(?<![\w(])(?:\(\d{3}\)[ ]?|\d{3}[-. ])\d{3}[-. ]\d{4}(?![\w])/g;
const LONG_TOKEN = /(?<![\w+=-])[A-Za-z0-9+_=-]{32,}(?![\w+=-])/g;

function looksLikeSecret(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) return true;
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// The Luhn check keeps long numeric ids and timestamps that merely look like card numbers.
const redactCard = (m: string): string => (luhn(m.replace(/\D/g, "")) ? "[card]" : m);

const redactPhone = (m: string): string => {
  const digits = m.replace(/\D/g, "").length;
  return digits >= 8 && digits <= 15 ? "[phone]" : m;
};

export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function redactUrl(url: string): string {
  return redactText(stripQuery(url));
}

export function redactText(s: string): string {
  return s
    .replace(HEADER_LINE, `$1$2: ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(KEY_VALUE, (_m, key: string, value: string) => {
      const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
      return `${key}${q}${REDACTED}${q}`;
    })
    .replace(URL_QUERY, `$1?${REDACTED}`)
    .replace(EMAIL, "[email]")
    .replace(CARD, redactCard)
    .replace(PHONE_INTL, redactPhone)
    .replace(PHONE_LOCAL, "[phone]")
    .replace(IPV4, "[ip]")
    .replace(IPV6, (m) => (/[0-9a-f]/i.test(m) ? "[ip]" : m))
    .replace(LONG_TOKEN, (m) => (looksLikeSecret(m) ? REDACTED : m));
}

export function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
