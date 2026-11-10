// Same values as EMAIL_LIMITS / EMAIL_STATUSES in @mybase-dev/sdk/email (the browser build can't
// import the SDK's source); the API checks them.
import type { EmailStatus } from "@mybase/shared";

export const EMAIL_STATUSES: readonly EmailStatus[] = ["queued", "sending", "sent", "delivered", "delayed", "bounced", "complained", "failed", "canceled"];
export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RETENTION_DAYS = { min: 1, max: 365 } as const;
