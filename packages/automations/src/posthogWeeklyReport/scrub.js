import { redactText, singleLine, truncate } from "../redact";
export function scrub(text, secrets, max = 300) {
    let out = text;
    for (const secret of secrets) {
        if (secret.length >= 4)
            out = out.split(secret).join("[redacted]");
    }
    return truncate(singleLine(redactText(out)), max);
}
