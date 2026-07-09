// Thin client for the Canton JSON Ledger API (v2), via the same-origin
// /ledger-api proxy. Encodes the empirically-verified gotchas:
//
// - Party IDs are per-participant-instance; always discover via listParties().
// - ACS reads are two-step: fetch ledger-end offset, then query at that offset.
// - In the ACS request, `verbose` goes INSIDE eventFormat; sending a top-level
//   `verbose` or `filter` alongside eventFormat is INVALID_ARGUMENT.
// - Requests use "#privia:Module:Entity" template IDs; responses resolve them
//   to "<package-id>:Module:Entity", so match on the module:entity suffix.
// - Auth is optional locally (unsecured sandbox); Authorization is attached
//   only when TOKEN is configured.

import { LEDGER_BASE, TOKEN, USER_ID } from "./config";
import { TEMPLATES, TemplateKey, Party, ContractId } from "./types";

export interface PartyInfo {
  partyId: Party;
  displayName: string;
}

export interface ActiveContract<T = Record<string, unknown>> {
  contractId: ContractId;
  templateId: string;
  payload: T;
  signatories: Party[];
  observers: Party[];
}

export class LedgerApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      `Ledger API ${status}: ` +
        (typeof body === "object" && body !== null && "cause" in body
          ? String((body as { cause: unknown }).cause)
          : JSON.stringify(body)),
    );
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  };
  const res = await fetch(`${LEDGER_BASE}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new LedgerApiError(res.status, body);
  return body as T;
}

export async function listParties(): Promise<PartyInfo[]> {
  const res = await request<{
    partyDetails: { party: string; isLocal: boolean }[];
  }>("/v2/parties");
  return res.partyDetails.map((p) => ({
    partyId: p.party,
    displayName: p.party.split("::")[0],
  }));
}

async function ledgerEnd(): Promise<number> {
  const res = await request<{ offset: number }>("/v2/state/ledger-end");
  return res.offset;
}

interface JsActiveContractEntry {
  contractEntry: {
    JsActiveContract?: {
      createdEvent: {
        contractId: string;
        templateId: string;
        createArgument: Record<string, unknown>;
        signatories: string[];
        observers: string[];
      };
    };
  };
}

export async function queryActiveContracts(
  party: Party,
): Promise<ActiveContract[]> {
  const offset = await ledgerEnd();
  const entries = await request<JsActiveContractEntry[]>(
    "/v2/state/active-contracts",
    {
      method: "POST",
      body: JSON.stringify({
        eventFormat: {
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    WildcardFilter: {
                      value: { includeCreatedEventBlob: false },
                    },
                  },
                },
              ],
            },
          },
          verbose: true,
        },
        activeAtOffset: offset,
      }),
    },
  );
  return entries
    .map((e) => e.contractEntry.JsActiveContract)
    .filter((c): c is NonNullable<typeof c> => c != null)
    .map(({ createdEvent }) => ({
      contractId: createdEvent.contractId,
      templateId: createdEvent.templateId,
      payload: createdEvent.createArgument,
      signatories: createdEvent.signatories,
      observers: createdEvent.observers,
    }));
}

// Responses carry package-id template IDs ("<pkg-id>:Module:Entity"), not the
// "#privia:Module:Entity" request form — compare on the module:entity suffix.
export function templateKeyOf(templateId: string): TemplateKey | undefined {
  const moduleEntity = templateId.split(":").slice(-2).join(":");
  return (Object.keys(TEMPLATES) as TemplateKey[]).find(
    (k) => TEMPLATES[k].split(":").slice(-2).join(":") === moduleEntity,
  );
}

export function matchesTemplate(
  contract: ActiveContract,
  key: TemplateKey,
): boolean {
  return templateKeyOf(contract.templateId) === key;
}

interface SubmitResponse {
  updateId: string;
  completionOffset: number;
}

function submitAndWait(
  command: Record<string, unknown>,
  actAs: Party,
): Promise<SubmitResponse> {
  return request<SubmitResponse>("/v2/commands/submit-and-wait", {
    method: "POST",
    body: JSON.stringify({
      commands: [command],
      userId: USER_ID,
      commandId: `privia-${crypto.randomUUID()}`,
      actAs: [actAs],
      readAs: [actAs],
    }),
  });
}

export function createContract(
  templateKey: TemplateKey,
  args: Record<string, unknown>,
  actAs: Party,
): Promise<SubmitResponse> {
  return submitAndWait(
    {
      CreateCommand: {
        templateId: TEMPLATES[templateKey],
        createArguments: args,
      },
    },
    actAs,
  );
}

export function exerciseChoice(
  templateKey: TemplateKey,
  contractId: ContractId,
  choice: string,
  choiceArgs: Record<string, unknown>,
  actAs: Party,
): Promise<SubmitResponse> {
  return submitAndWait(
    {
      ExerciseCommand: {
        templateId: TEMPLATES[templateKey],
        contractId,
        choice,
        choiceArgument: choiceArgs,
      },
    },
    actAs,
  );
}

// ---------- named flows over the Privia templates ----------

export const acknowledgeInvoice = (invoiceCid: ContractId, buyer: Party) =>
  exerciseChoice("Invoice", invoiceCid, "Invoice_Acknowledge", {}, buyer);

// Opens a sealed-bid auction on an acknowledged invoice: creates the Auction,
// then issues one BidInvite per invited financier. submit-and-wait doesn't
// return contract IDs, so the fresh Auction is located via an ACS re-read
// (matched on invoiceCid, which is unique per acknowledged invoice).
export async function openAuction(
  supplier: Party,
  ack: { contractId: ContractId; payload: Record<string, unknown> },
): Promise<void> {
  const p = ack.payload as {
    invoiceId: string;
    faceAmount: string;
    currency: string;
    dueDate: string;
    financiers: string[];
  };
  await createContract(
    "Auction",
    {
      supplier,
      invoiceCid: ack.contractId,
      invoiceId: p.invoiceId,
      faceAmount: p.faceAmount,
      currency: p.currency,
      dueDate: p.dueDate,
      financiers: p.financiers,
    },
    supplier,
  );
  const acs = await queryActiveContracts(supplier);
  const auction = acs.find(
    (c) =>
      templateKeyOf(c.templateId) === "Auction" &&
      (c.payload as { invoiceCid?: string }).invoiceCid === ack.contractId,
  );
  if (!auction) throw new Error("Auction not found after creation.");
  await exerciseChoice(
    "Auction",
    auction.contractId,
    "Auction_CreateInvites",
    {},
    supplier,
  );
}

export const placeBid = (
  inviteCid: ContractId,
  amount: string,
  financier: Party,
) =>
  exerciseChoice("BidInvite", inviteCid, "BidInvite_PlaceBid", { amount }, financier);

export const reviseBid = (
  bidCid: ContractId,
  newAmount: string,
  financier: Party,
) => exerciseChoice("Bid", bidCid, "Bid_Revise", { newAmount }, financier);

export const withdrawBid = (bidCid: ContractId, financier: Party) =>
  exerciseChoice("Bid", bidCid, "Bid_Withdraw", {}, financier);

// Supplier accepts the winning bid; losing bids are retired and every invited
// financier receives an OfferOutcome, all in one transaction.
export const acceptBid = (
  auctionCid: ContractId,
  winningBidCid: ContractId,
  losingBidCids: ContractId[],
  supplier: Party,
) =>
  exerciseChoice(
    "Auction",
    auctionCid,
    "Auction_Accept",
    { winningBidCid, losingBidCids },
    supplier,
  );

export const dismissOutcome = (outcomeCid: ContractId, financier: Party) =>
  exerciseChoice("OfferOutcome", outcomeCid, "OfferOutcome_Dismiss", {}, financier);

export const settleReceivable = (
  receivableCid: ContractId,
  paymentCid: ContractId,
  buyer: Party,
) =>
  exerciseChoice(
    "FinancedReceivable",
    receivableCid,
    "FinancedReceivable_Settle",
    { paymentCid },
    buyer,
  );
