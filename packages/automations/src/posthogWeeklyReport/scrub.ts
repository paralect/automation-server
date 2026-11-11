import { redactText, singleLine, truncate } from "../redact";

/** Removes each known secret verbatim, then applies the generic redactor, and bounds the length. */
export function scrub(text: string, secrets: readonly string[], max = 300): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return truncate(singleLine(redactText(out)), max);
}
