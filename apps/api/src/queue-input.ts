import { BadRequestError } from "./errors";

/** Listing cursors are bigint strings: never round them through a JS number. */
export function messageCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new BadRequestError("invalid message cursor");
  return value;
}

/** A supplied empty selection must fail rather than accidentally redrive the whole queue. */
export function redriveSelection(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100 ||
    value.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  ) {
    throw new BadRequestError("messageIds must contain 1–100 message UUIDs");
  }
  return [...new Set((value as string[]).map((id) => id.toLowerCase()))];
}
