"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActiveContract,
  createContract,
  exerciseChoice,
  LedgerApiError,
  listParties,
  PartyInfo,
  queryActiveContracts,
  templateKeyOf,
} from "@/lib/ledger";
import {
  AcknowledgedInvoice,
  Cash,
  FinancedReceivable,
  FinancingOffer,
  Invoice,
  TemplateKey,
} from "@/lib/types";

// ---------- personas ----------

const PERSONAS = [
  { key: "Supplier", label: "Supplier", tagline: "raises capital against receivables" },
  { key: "Buyer", label: "Buyer", tagline: "confirms and settles invoices" },
  { key: "FinancierA", label: "Financier A", tagline: "advances funds against invoices" },
  { key: "FinancierB", label: "Financier B", tagline: "competing financier" },
] as const;

type PersonaKey = (typeof PERSONAS)[number]["key"];

// ---------- helpers ----------

const fmtAmount = (s: string) =>
  parseFloat(s).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const asDecimal = (s: string) => (s.includes(".") ? s : `${s}.0`);

const shortParty = (p: string) => p.split("::")[0];

function groupContracts(contracts: ActiveContract[]) {
  const groups: Partial<Record<TemplateKey, ActiveContract[]>> = {};
  for (const c of contracts) {
    const key = templateKeyOf(c.templateId);
    if (key) (groups[key] ??= []).push(c);
  }
  return groups;
}

const isStaleContractError = (e: unknown) =>
  e instanceof LedgerApiError &&
  /CONTRACT_NOT_FOUND|could not be found|not found|inactive|archived/i.test(
    e.message,
  );

// ---------- page ----------

export default function PriviaApp() {
  const [parties, setParties] = useState<PartyInfo[]>([]);
  const [persona, setPersona] = useState<PersonaKey>("Supplier");
  const [contracts, setContracts] = useState<ActiveContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  const [lastSuccess, setLastSuccess] = useState<string | null>(null);

  const partyOf = useCallback(
    (key: PersonaKey) => parties.find((p) => p.displayName === key)?.partyId,
    [parties],
  );
  const me = partyOf(persona);

  const refresh = useCallback(async () => {
    if (!me) return;
    setLoading(true);
    try {
      setContracts(await queryActiveContracts(me));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    listParties()
      .then(setParties)
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    setRejection(null);
    setError(null);
    setLastSuccess(null);
    refresh();
  }, [refresh]);

  const groups = useMemo(() => groupContracts(contracts), [contracts]);

  // Wraps an action: clears banners, runs it, refreshes the ACS.
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setRejection(null);
    setLastSuccess(null);
    try {
      await fn();
      setLastSuccess(label);
    } catch (e) {
      if (isStaleContractError(e)) {
        setRejection(
          "This invoice has already been financed. The receivable cannot be sold twice — the ledger consumed it when the first offer was accepted.",
        );
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  // -- persona actions --

  const acknowledge = (c: ActiveContract) =>
    act("Invoice acknowledged — the debt is now confirmed on-ledger.", () =>
      exerciseChoice("Invoice", c.contractId, "Invoice_Acknowledge", {}, me!),
    );

  const makeOffer = (c: ActiveContract, advanceAmount: string) =>
    act("Offer submitted to the supplier.", () =>
      createContract(
        "FinancingOffer",
        {
          financier: me!,
          supplier: (c.payload as unknown as AcknowledgedInvoice).supplier,
          invoiceCid: c.contractId,
          advanceAmount: asDecimal(advanceAmount),
          currency: (c.payload as unknown as AcknowledgedInvoice).currency,
        },
        me!,
      ),
    );

  const acceptOffer = (c: ActiveContract) =>
    act(
      "Offer accepted — receivable transferred and cash advanced atomically.",
      () =>
        exerciseChoice(
          "FinancingOffer",
          c.contractId,
          "FinancingOffer_Accept",
          {},
          me!,
        ),
    );

  const settle = async (c: ActiveContract) => {
    const rcv = c.payload as unknown as FinancedReceivable;
    await act("Receivable settled — payment delivered to the financier.", async () => {
      await createContract(
        "Cash",
        {
          issuer: me!,
          owner: me!,
          amount: rcv.faceAmount,
          currency: rcv.currency,
        },
        me!,
      );
      // submit-and-wait doesn't return contract IDs; find the fresh Cash in the ACS.
      const acs = await queryActiveContracts(me!);
      const payment = acs.find(
        (x) =>
          templateKeyOf(x.templateId) === "Cash" &&
          (x.payload as unknown as Cash).owner === me &&
          parseFloat((x.payload as unknown as Cash).amount) ===
            parseFloat(rcv.faceAmount),
      );
      if (!payment) throw new Error("payment cash not found after creation");
      await exerciseChoice(
        "FinancedReceivable",
        c.contractId,
        "FinancedReceivable_Settle",
        { paymentCid: payment.contractId },
        me!,
      );
    });
  };

  const issueInvoice = (args: Record<string, unknown>) =>
    act("Invoice issued — now visible to the buyer.", () =>
      createContract("Invoice", args, me!),
    );

  return (
    <main className="mx-auto w-full max-w-5xl px-6 pb-24">
      <Header />
      <PersonaSwitcher persona={persona} setPersona={setPersona} />

      {rejection && <RejectionBanner message={rejection} />}
      {lastSuccess && (
        <div className="mb-6 rounded-xl border border-brand/30 bg-brand-soft px-5 py-3 text-sm font-medium text-brand-dark">
          ✓ {lastSuccess}
        </div>
      )}
      {error && (
        <div className="mb-6 rounded-xl border border-red-300 bg-red-50 px-5 py-3 text-sm text-red-800">
          <span className="font-semibold">Ledger error:</span> {error}
        </div>
      )}

      {loading ? (
        <p className="py-12 text-center text-sm text-brand-dark/50">
          reading {persona}&apos;s view of the ledger…
        </p>
      ) : (
        <>
          <PrivacyNote persona={persona} groups={groups} />
          <div className="mt-8 space-y-10">
            {persona === "Supplier" && (
              <IssueInvoiceForm
                supplier={me!}
                buyers={parties.filter((p) => p.displayName === "Buyer")}
                financiers={parties.filter((p) =>
                  p.displayName.startsWith("Financier"),
                )}
                busy={busy}
                onSubmit={issueInvoice}
              />
            )}

            <Section title="Invoices" hint="issued, awaiting buyer confirmation">
              {(groups.Invoice ?? []).map((c) => {
                const inv = c.payload as unknown as Invoice;
                return (
                  <Card key={c.contractId}>
                    <CardTitle
                      title={inv.invoiceId}
                      amount={`${fmtAmount(inv.faceAmount)} ${inv.currency}`}
                    />
                    <Field k="supplier" v={shortParty(inv.supplier)} />
                    <Field k="buyer" v={shortParty(inv.buyer)} />
                    <Field k="due" v={inv.dueDate} />
                    <Field
                      k="invited financiers"
                      v={inv.financiers.map(shortParty).join(", ") || "none"}
                    />
                    {persona === "Buyer" && (
                      <ActionButton
                        busy={busy}
                        onClick={() => acknowledge(c)}
                        label="Acknowledge debt"
                      />
                    )}
                  </Card>
                );
              })}
            </Section>

            <Section
              title="Acknowledged invoices"
              hint="buyer-confirmed receivables, ready to finance"
            >
              {(groups.AcknowledgedInvoice ?? []).map((c) => {
                const inv = c.payload as unknown as AcknowledgedInvoice;
                return (
                  <Card key={c.contractId}>
                    <CardTitle
                      title={`${inv.invoiceId} · confirmed`}
                      amount={`${fmtAmount(inv.faceAmount)} ${inv.currency}`}
                    />
                    <Field k="supplier" v={shortParty(inv.supplier)} />
                    <Field k="buyer" v={shortParty(inv.buyer)} />
                    <Field k="due" v={inv.dueDate} />
                    {(persona === "FinancierA" || persona === "FinancierB") && (
                      <OfferForm
                        busy={busy}
                        faceAmount={inv.faceAmount}
                        onOffer={(amt) => makeOffer(c, amt)}
                      />
                    )}
                  </Card>
                );
              })}
            </Section>

            <Section title="Financing offers" hint="advance terms on the table">
              {(groups.FinancingOffer ?? []).map((c) => {
                const o = c.payload as unknown as FinancingOffer;
                return (
                  <Card key={c.contractId}>
                    <CardTitle
                      title={`Offer from ${shortParty(o.financier)}`}
                      amount={`${fmtAmount(o.advanceAmount)} ${o.currency}`}
                    />
                    <Field k="to" v={shortParty(o.supplier)} />
                    <Field k="advance" v={`${fmtAmount(o.advanceAmount)} ${o.currency}`} />
                    {persona === "Supplier" && (
                      <ActionButton
                        busy={busy}
                        onClick={() => acceptOffer(c)}
                        label="Accept offer"
                      />
                    )}
                  </Card>
                );
              })}
            </Section>

            <Section
              title="Financed receivables"
              hint="collection rights held by the financier"
            >
              {(groups.FinancedReceivable ?? []).map((c) => {
                const r = c.payload as unknown as FinancedReceivable;
                return (
                  <Card key={c.contractId}>
                    <CardTitle
                      title={`${r.invoiceId} · financed by ${shortParty(r.financier)}`}
                      amount={`${fmtAmount(r.faceAmount)} ${r.currency}`}
                    />
                    <Field k="advanced" v={`${fmtAmount(r.advanceAmount)} ${r.currency}`} />
                    <Field k="buyer owes" v={`${fmtAmount(r.faceAmount)} ${r.currency}`} />
                    <Field k="due" v={r.dueDate} />
                    {persona === "Buyer" && (
                      <ActionButton
                        busy={busy}
                        onClick={() => settle(c)}
                        label="Settle at face value"
                      />
                    )}
                  </Card>
                );
              })}
            </Section>

            <Section title="Cash" hint="on-ledger IOUs">
              {(groups.Cash ?? []).map((c) => {
                const cash = c.payload as unknown as Cash;
                return (
                  <Card key={c.contractId}>
                    <CardTitle
                      title={`Issued by ${shortParty(cash.issuer)}`}
                      amount={`${fmtAmount(cash.amount)} ${cash.currency}`}
                    />
                    <Field k="owner" v={shortParty(cash.owner)} />
                  </Card>
                );
              })}
            </Section>
          </div>
        </>
      )}
    </main>
  );
}

// ---------- chrome ----------

function Header() {
  return (
    <header className="flex items-center gap-3 py-8">
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
        <rect width="34" height="34" rx="9" fill="#14685A" />
        <path
          d="M12 25V9h6.4c3.6 0 5.8 2 5.8 5.2s-2.2 5.2-5.8 5.2H16V25h-4zm4-9h2.2c1.5 0 2.4-.7 2.4-1.8s-.9-1.8-2.4-1.8H16v3.6z"
          fill="#FAF7F2"
        />
      </svg>
      <div>
        <h1 className="text-xl font-bold tracking-tight text-brand-dark">
          Privia
        </h1>
        <p className="text-xs text-brand-dark/60">
          confidential invoice financing · Canton Network
        </p>
      </div>
    </header>
  );
}

function PersonaSwitcher({
  persona,
  setPersona,
}: {
  persona: PersonaKey;
  setPersona: (k: PersonaKey) => void;
}) {
  return (
    <div className="mb-8">
      <div className="flex flex-wrap gap-2">
        {PERSONAS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPersona(p.key)}
            className={`rounded-full px-5 py-2.5 text-sm font-semibold transition-colors ${
              persona === p.key
                ? "bg-brand text-white shadow-sm"
                : "bg-white text-brand-dark/70 ring-1 ring-brand-dark/10 hover:ring-brand/40"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="mt-3 text-sm text-brand-dark/60">
        Viewing the ledger as{" "}
        <span className="font-semibold text-brand">
          {PERSONAS.find((p) => p.key === persona)?.label}
        </span>{" "}
        — {PERSONAS.find((p) => p.key === persona)?.tagline}. Everything below
        is this party&apos;s private view; no other party sees it.
      </p>
    </div>
  );
}

function RejectionBanner({ message }: { message: string }) {
  return (
    <div className="mb-6 overflow-hidden rounded-2xl border-2 border-red-600 bg-red-600 shadow-lg">
      <div className="px-6 py-4 text-white">
        <div className="text-xs font-bold uppercase tracking-widest opacity-80">
          Transaction rejected by the ledger
        </div>
        <div className="mt-1 text-lg font-bold leading-snug">
          Double-financing blocked.
        </div>
      </div>
      <div className="bg-white px-6 py-4 text-sm text-red-900">
        {message}
        <div className="mt-2 text-xs text-red-700/70">
          Not a policy check — the contract this offer referenced no longer
          exists. Consumption semantics make the fraud structurally impossible.
        </div>
      </div>
    </div>
  );
}

function PrivacyNote({
  persona,
  groups,
}: {
  persona: PersonaKey;
  groups: Partial<Record<TemplateKey, ActiveContract[]>>;
}) {
  const count = (k: TemplateKey) => groups[k]?.length ?? 0;
  const visible = (
    [
      ["Invoice", "invoice"],
      ["AcknowledgedInvoice", "acknowledged invoice"],
      ["FinancingOffer", "financing offer"],
      ["FinancedReceivable", "financed receivable"],
      ["Cash", "cash holding"],
    ] as [TemplateKey, string][]
  )
    .filter(([k]) => count(k) > 0)
    .map(([k, label]) => `${count(k)} ${label}${count(k) > 1 ? "s" : ""}`);

  const hidden: Record<PersonaKey, string> = {
    Supplier: "Financiers' books, competing quotes they haven't sent you, buyer's other liabilities.",
    Buyer: "Financing offers and advance terms — the supplier's funding costs are not the buyer's business.",
    FinancierA: "Financier B's competing offers and terms, the supplier's other receivables and cash.",
    FinancierB: "Financier A's competing offers and terms, the supplier's other receivables and cash.",
  };

  return (
    <div className="rounded-xl bg-brand-dark px-5 py-4 text-sm text-white/90">
      <span className="font-semibold text-white">On this party&apos;s ledger:</span>{" "}
      {visible.length > 0 ? visible.join(", ") : "nothing yet"}.
      <span className="ml-1 text-white/60">
        Not visible from here: {hidden[persona]}
      </span>
    </div>
  );
}

// ---------- building blocks ----------

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : [children];
  const empty =
    items.length === 0 || (Array.isArray(items[0]) && items[0].length === 0);
  if (empty) return null;
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-base font-bold text-brand-dark">{title}</h2>
        <span className="text-xs text-brand-dark/50">{hint}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-brand-dark/10 bg-white p-5 shadow-sm">
      {children}
    </div>
  );
}

function CardTitle({ title, amount }: { title: string; amount: string }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="font-semibold text-brand-dark">{title}</div>
      <div className="whitespace-nowrap rounded-lg bg-brand-soft px-2.5 py-1 text-sm font-bold text-brand">
        {amount}
      </div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-t border-brand-dark/5 py-1.5 text-sm">
      <span className="text-brand-dark/50">{k}</span>
      <span className="font-medium text-brand-dark">{v}</span>
    </div>
  );
}

function ActionButton({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="mt-4 w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      {busy ? "submitting…" : label}
    </button>
  );
}

function OfferForm({
  busy,
  faceAmount,
  onOffer,
}: {
  busy: boolean;
  faceAmount: string;
  onOffer: (amount: string) => void;
}) {
  const [amount, setAmount] = useState(
    (parseFloat(faceAmount) * 0.95).toFixed(1),
  );
  return (
    <form
      className="mt-4 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onOffer(amount);
      }}
    >
      <input
        type="number"
        step="0.01"
        min="0.01"
        required
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-32 rounded-xl border border-brand-dark/15 px-3 py-2 text-sm"
        aria-label="advance amount"
      />
      <button
        type="submit"
        disabled={busy}
        className="flex-1 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {busy ? "submitting…" : "Make offer"}
      </button>
    </form>
  );
}

function IssueInvoiceForm({
  supplier,
  buyers,
  financiers,
  busy,
  onSubmit,
}: {
  supplier: string;
  buyers: PartyInfo[];
  financiers: PartyInfo[];
  busy: boolean;
  onSubmit: (args: Record<string, unknown>) => void;
}) {
  const [invoiceId, setInvoiceId] = useState("");
  const [faceAmount, setFaceAmount] = useState("100");
  const [currency, setCurrency] = useState("USD");
  const [dueDate, setDueDate] = useState("2026-12-31");
  const buyer = buyers[0]?.partyId ?? "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      supplier,
      buyer,
      invoiceId,
      faceAmount: asDecimal(faceAmount),
      currency,
      dueDate,
      financiers: financiers.map((f) => f.partyId),
    });
    setInvoiceId("");
  };

  return (
    <section className="rounded-2xl border border-brand/25 bg-brand-soft/50 p-5">
      <h2 className="mb-3 text-base font-bold text-brand-dark">
        Issue an invoice
      </h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <label className="text-xs font-medium text-brand-dark/70">
          invoice id
          <input
            required
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            placeholder="INV-002"
            className="mt-1 block w-36 rounded-xl border border-brand-dark/15 bg-white px-3 py-2 text-sm text-brand-dark"
          />
        </label>
        <label className="text-xs font-medium text-brand-dark/70">
          amount
          <input
            type="number"
            step="0.01"
            min="0.01"
            required
            value={faceAmount}
            onChange={(e) => setFaceAmount(e.target.value)}
            className="mt-1 block w-28 rounded-xl border border-brand-dark/15 bg-white px-3 py-2 text-sm text-brand-dark"
          />
        </label>
        <label className="text-xs font-medium text-brand-dark/70">
          currency
          <input
            required
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="mt-1 block w-20 rounded-xl border border-brand-dark/15 bg-white px-3 py-2 text-sm text-brand-dark"
          />
        </label>
        <label className="text-xs font-medium text-brand-dark/70">
          due date
          <input
            type="date"
            required
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="mt-1 block rounded-xl border border-brand-dark/15 bg-white px-3 py-2 text-sm text-brand-dark"
          />
        </label>
        <label className="text-xs font-medium text-brand-dark/70">
          buyer
          <input
            disabled
            value={buyers[0]?.displayName ?? "—"}
            className="mt-1 block w-24 rounded-xl border border-brand-dark/10 bg-brand-dark/5 px-3 py-2 text-sm text-brand-dark/60"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !buyer}
          className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "submitting…" : "Issue invoice"}
        </button>
      </form>
      <p className="mt-3 text-xs text-brand-dark/50">
        Invited to bid once the buyer confirms:{" "}
        {financiers.map((f) => f.displayName).join(", ") || "no financiers found"}.
        They see nothing until acknowledgment.
      </p>
    </section>
  );
}
