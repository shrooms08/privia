// TypeScript mirrors of the Daml templates in daml/Privia/.
//
// JSON Ledger API encodings: Party = full party ID string ("Hint::1220...");
// Decimal = string ("100.0" in, "100.0000000000" back); Date = "YYYY-MM-DD";
// ContractId = string.

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

export interface FinancingOffer {
  financier: Party;
  supplier: Party;
  invoiceCid: ContractId;
  advanceAmount: Decimal;
  currency: string;
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
  | "FinancingOffer"
  | "FinancedReceivable"
  | "Cash";

// Request-form template IDs (package-name form). Responses come back with the
// resolved package-id form, so match responses via moduleEntity() instead.
export const TEMPLATES: Record<TemplateKey, string> = {
  Invoice: "#privia:Privia.Invoice:Invoice",
  AcknowledgedInvoice: "#privia:Privia.Invoice:AcknowledgedInvoice",
  FinancingOffer: "#privia:Privia.Financing:FinancingOffer",
  FinancedReceivable: "#privia:Privia.Financing:FinancedReceivable",
  Cash: "#privia:Privia.Cash:Cash",
};
