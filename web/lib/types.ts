// TypeScript mirrors of the Daml templates in daml/Privia/.
//
// JSON Ledger API encodings: Party = full party ID string ("Hint::1220...");
// Decimal = string ("100.0" in, "100.0000000000" back); Date = "YYYY-MM-DD";
// ContractId = string; Optional = value | null; enums = constructor name
// as a string.

export type Party = string;
export type Decimal = string;
export type DamlDate = string;
export type ContractId = string;

export interface Invoice {
  supplier: Party;
  buyer: Party;
  invoiceId: string;
  faceAmount: Decimal;
  currency: string;
  dueDate: DamlDate;
  financiers: Party[];
}

export interface AcknowledgedInvoice {
  supplier: Party;
  buyer: Party;
  invoiceId: string;
  faceAmount: Decimal;
  currency: string;
  dueDate: DamlDate;
  financiers: Party[];
}

export interface Auction {
  supplier: Party;
  invoiceCid: ContractId;
  invoiceId: string;
  faceAmount: Decimal;
  currency: string;
  dueDate: DamlDate;
  financiers: Party[];
}

export interface BidInvite {
  supplier: Party;
  financier: Party;
  auctionCid: ContractId;
  invoiceCid: ContractId;
  currency: string;
}

export interface Bid {
  financier: Party;
  supplier: Party;
  auctionCid: ContractId;
  invoiceCid: ContractId;
  amount: Decimal;
  currency: string;
}

export type BidResult = "Won" | "NotSelected";

export interface OfferOutcome {
  supplier: Party;
  financier: Party;
  invoiceId: string;
  result: BidResult;
  // Optional Decimal: the JSON API omits the field entirely when None.
  amount?: Decimal | null;
}

export interface FinancedReceivable {
  financier: Party;
  supplier: Party;
  buyer: Party;
  invoiceId: string;
  faceAmount: Decimal;
  currency: string;
  dueDate: DamlDate;
  advanceAmount: Decimal;
}

export interface Cash {
  issuer: Party;
  owner: Party;
  amount: Decimal;
  currency: string;
}

export type TemplateKey =
  | "Invoice"
  | "AcknowledgedInvoice"
  | "Auction"
  | "BidInvite"
  | "Bid"
  | "OfferOutcome"
  | "FinancedReceivable"
  | "Cash";

// Request-form template IDs (package-name form). Responses come back with the
// resolved package-id form, so match responses via templateKeyOf() instead.
export const TEMPLATES: Record<TemplateKey, string> = {
  Invoice: "#privia:Privia.Invoice:Invoice",
  AcknowledgedInvoice: "#privia:Privia.Invoice:AcknowledgedInvoice",
  Auction: "#privia:Privia.Auction:Auction",
  BidInvite: "#privia:Privia.Auction:BidInvite",
  Bid: "#privia:Privia.Auction:Bid",
  OfferOutcome: "#privia:Privia.Auction:OfferOutcome",
  FinancedReceivable: "#privia:Privia.Financing:FinancedReceivable",
  Cash: "#privia:Privia.Cash:Cash",
};
