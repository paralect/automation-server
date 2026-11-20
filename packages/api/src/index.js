import { createHash, timingSafeEqual } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
export const o = os.$context();
const digest = (value) => createHash("sha256").update(value).digest();
export const adminProcedure = o.use(({ context, next }) => {
    const { adminToken, bearer } = context;
    if (!adminToken || !bearer || !timingSafeEqual(digest(adminToken), digest(bearer))) {
        throw new ORPCError("UNAUTHORIZED");
    }
    return next();
});
