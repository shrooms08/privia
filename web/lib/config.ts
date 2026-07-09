// Ledger client configuration.
//
// Locally the sandbox enforces no auth, so TOKEN stays undefined and no
// Authorization header is sent. Against a secured participant (testnet),
// set NEXT_PUBLIC_LEDGER_TOKEN and the client sends it — config-only switch.

export const LEDGER_BASE = "/ledger-api";

export const TOKEN: string | undefined =
  process.env.NEXT_PUBLIC_LEDGER_TOKEN || undefined;

// Canton 3.x tokens identify a user, not a party; the party goes in actAs.
export const USER_ID = process.env.NEXT_PUBLIC_LEDGER_USER_ID ?? "ledger-api-user";
