/**
 * Parse the host-provided `IS_MOUNTS` env var into a mount list. The desktop owns
 * the conversation's durable working set and passes it comma-separated on the
 * (inherited) pi env; we split, trim, drop empties, and dedupe. Path resolution +
 * absolute-dedupe happen in the extension's `addMount`; this stays pure so it's
 * testable without the runtime.
 *
 * Known edge: a path containing a comma would split wrong — rare; revisit the
 * separator if it ever bites.
 */
export function parseMountEnv(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}
