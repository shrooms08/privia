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
  {
    key: "Supplier",
    label: "Supplier",
    role: "Raises capital against receivables",
    accent: "#14685A",
    empty:
      "No contracts on this ledger yet. Issue an invoice above to start a deal.",
  },
  {
    key: "Buyer",
    label: "Buyer",
    role: "Confirms and settles invoices",
    accent: "#8C5E2A",
    empty:
      "Nothing visible yet. When the supplier issues an invoice to you, it appears here for acknowledgment.",
  },
  {
    key: "FinancierA",
    label: "Financier A",
    role: "Advances funds against confirmed invoices",
    accent: "#2F5A8C",
    empty:
      "Nothing visible yet. You'll see receivables only after the buyer confirms them — never unverified invoices.",
  },
  {
    key: "FinancierB",
    label: "Financier B",
    role: "Competing financier",
    accent: "#6B4A8C",
    empty:
      "Nothing visible yet. You'll see receivables only after the buyer confirms them — never unverified invoices.",
  },
] as const;

type PersonaKey = (typeof PERSONAS)[number]["key"];
type Persona = (typeof PERSONAS)[number];

// ---------- helpers ----------

const fmtMoney = (amount: string, currency: string) =>
  `${parseFloat(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;

const asDecimal = (s: string) => (s.includes(".") ? s : `${s}.0`);

const shortParty = (p: string | undefined) => p?.split("::")[0] ?? "—";

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

// ---------- lifecycle tracker ----------

const STAGES = ["Issued", "Acknowledged", "Offers in", "Financed", "Settled"] as const;

// Derives each deal's stage from what this persona actually sees on-ledger.
// `settledIds` is a session-local record of settles we performed and the
// ledger confirmed — settlement consumes the receivable, so it can't be read
// back from the ACS.
function dealStages(
  groups: Partial<Record<TemplateKey, ActiveContract[]>>,
  settledIds: Set<string>,
): { invoiceId: string; stage: number }[] {
  const deals = new Map<string, number>();
  const bump = (id: string, stage: number) =>
    deals.set(id, Math.max(deals.get(id) ?? 0, stage));

  for (const c of groups.Invoice ?? [])
    bump((c.payload as unknown as Invoice).invoiceId, 1);
  for (const c of groups.AcknowledgedInvoice ?? []) {
    const inv = c.payload as unknown as AcknowledgedInvoice;
    const hasOffers = (groups.FinancingOffer ?? []).some(
      (o) => (o.payload as unknown as FinancingOffer).invoiceCid === c.contractId,
    );
    bump(inv.invoiceId, hasOffers ? 3 : 2);
  }
  for (const c of groups.FinancedReceivable ?? [])
    bump((c.payload as unknown as FinancedReceivable).invoiceId, 4);
  for (const id of settledIds) bump(id, 5);

  return [...deals.entries()]
    .map(([invoiceId, stage]) => ({ invoiceId, stage }))
    .sort((a, b) => b.stage - a.stage);
}

// ---------- page ----------

export default function PriviaApp() {
  const [parties, setParties] = useState<PartyInfo[]>([]);
  const [personaKey, setPersonaKey] = useState<PersonaKey>("Supplier");
  const [contracts, setContracts] = useState<ActiveContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejection, setRejection] = useState(false);
  const [lastSuccess, setLastSuccess] = useState<string | null>(null);
  const [settledIds, setSettledIds] = useState<Set<string>>(new Set());

  const persona = PERSONAS.find((p) => p.key === personaKey)!;
  const partyOf = useCallback(
    (key: PersonaKey) => parties.find((p) => p.displayName === key)?.partyId,
    [parties],
  );
  const me = partyOf(personaKey);

  const refresh = useCallback(async () => {
    if (!me) return;
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
    setRejection(false);
    setError(null);
    setLastSuccess(null);
    setLoading(true);
    refresh();
  }, [refresh]);

  const groups = useMemo(() => groupContracts(contracts), [contracts]);
  const deals = useMemo(
    () => dealStages(groups, settledIds),
    [groups, settledIds],
  );

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setRejection(false);
    setLastSuccess(null);
    try {
      await fn();
      setLastSuccess(label);
    } catch (e) {
      if (isStaleContractError(e)) {
        setRejection(true);
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
    act("Invoice acknowledged. The debt is now confirmed on-ledger.", () =>
      exerciseChoice("Invoice", c.contractId, "Invoice_Acknowledge", {}, me!),
    );

  const makeOffer = (c: ActiveContract, advanceAmount: string) =>
    act("Offer submitted. Only you and the supplier can see it.", () =>
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
      "Offer accepted. Receivable transferred and cash advanced in one atomic transaction.",
      () =>
        exerciseChoice(
          "FinancingOffer",
          c.contractId,
          "FinancingOffer_Accept",
          {},
          me!,
        ),
    );

  const settle = (c: ActiveContract) => {
    const rcv = c.payload as unknown as FinancedReceivable;
    return act("Receivable settled. Payment delivered to the financier.", async () => {
      await createContract(
        "Cash",
        { issuer: me!, owner: me!, amount: rcv.faceAmount, currency: rcv.currency },
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
      if (!payment) throw new Error("Payment cash not found after creation.");
      await exerciseChoice(
        "FinancedReceivable",
        c.contractId,
        "FinancedReceivable_Settle",
        { paymentCid: payment.contractId },
        me!,
      );
      setSettledIds((s) => new Set(s).add(rcv.invoiceId));
    });
  };

  const issueInvoice = (args: Record<string, unknown>) =>
    act("Invoice issued. It is now visible to the buyer — and no one else.", () =>
      createContract("Invoice", args, me!),
    );

  const isEmpty = !loading && contracts.length === 0;

  return (
    <div className="min-h-screen">
      <TopBar />
      <main className="mx-auto w-full max-w-5xl px-6 pb-24">
        <PersonaSwitcher
          persona={persona}
          setPersonaKey={setPersonaKey}
          busy={busy}
        />

        {/* keyed by persona so the whole view re-enters on identity change */}
        <div key={personaKey} className="enter-view">
          {rejection && <RejectionBanner />}
          {lastSuccess && <SuccessBanner message={lastSuccess} />}
          {error && <ErrorBanner message={error} />}

          {loading ? (
            <SkeletonView />
          ) : (
            <>
              <PrivacyStrip persona={persona} groups={groups} />
              {deals.length > 0 && <LifecycleTracker deals={deals} />}

              <div className="mt-10 space-y-12">
                {personaKey === "Supplier" && (
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

                {isEmpty && <EmptyState persona={persona} />}

                <Section title="Invoices" hint="issued, awaiting buyer confirmation">
                  {(groups.Invoice ?? []).map((c) => {
                    const inv = c.payload as unknown as Invoice;
                    return (
                      <Card key={c.contractId}>
                        <CardTitle
                          title={inv.invoiceId}
                          badge="awaiting confirmation"
                          amount={fmtMoney(inv.faceAmount, inv.currency)}
                        />
                        <Field k="Supplier" v={shortParty(inv.supplier)} />
                        <Field k="Buyer" v={shortParty(inv.buyer)} />
                        <Field k="Due" v={inv.dueDate} />
                        <Field
                          k="Invited financiers"
                          v={
                            inv.financiers?.map(shortParty).join(", ") || "none"
                          }
                        />
                        {personaKey === "Buyer" && (
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
                  title="Confirmed receivables"
                  hint="buyer-acknowledged, open for financing"
                >
                  {(groups.AcknowledgedInvoice ?? []).map((c) => {
                    const inv = c.payload as unknown as AcknowledgedInvoice;
                    return (
                      <Card key={c.contractId}>
                        <CardTitle
                          title={inv.invoiceId}
                          badge="buyer confirmed"
                          amount={fmtMoney(inv.faceAmount, inv.currency)}
                        />
                        <Field k="Supplier" v={shortParty(inv.supplier)} />
                        <Field k="Buyer" v={shortParty(inv.buyer)} />
                        <Field k="Due" v={inv.dueDate} />
                        {(personaKey === "FinancierA" ||
                          personaKey === "FinancierB") && (
                          <OfferForm
                            busy={busy}
                            faceAmount={inv.faceAmount}
                            currency={inv.currency}
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
                          title={`Offer · ${shortParty(o.financier)}`}
                          badge={
                            personaKey === "Supplier" ? "your decision" : "pending"
                          }
                          amount={fmtMoney(o.advanceAmount, o.currency)}
                        />
                        <Field k="Financier" v={shortParty(o.financier)} />
                        <Field k="To" v={shortParty(o.supplier)} />
                        <Field
                          k="Advance"
                          v={fmtMoney(o.advanceAmount, o.currency)}
                        />
                        {personaKey === "Supplier" && (
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
                          title={`${r.invoiceId} · ${shortParty(r.financier)}`}
                          badge="financed"
                          amount={fmtMoney(r.faceAmount, r.currency)}
                        />
                        <Field
                          k="Advanced"
                          v={fmtMoney(r.advanceAmount, r.currency)}
                        />
                        <Field
                          k="Buyer owes"
                          v={fmtMoney(r.faceAmount, r.currency)}
                        />
                        <Field k="Due" v={r.dueDate} />
                        {personaKey === "Buyer" && (
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
                          badge="cash"
                          amount={fmtMoney(cash.amount, cash.currency)}
                        />
                        <Field k="Owner" v={shortParty(cash.owner)} />
                      </Card>
                    );
                  })}
                </Section>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------- chrome ----------

function TopBar() {
  return (
    <header className="border-b border-brand-dark/10 bg-background/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 py-4">
        <svg width="30" height="30" viewBox="0 0 34 34" aria-hidden="true">
          <rect width="34" height="34" rx="9" fill="#14685A" />
          <path
            d="M12 25V9h6.4c3.6 0 5.8 2 5.8 5.2s-2.2 5.2-5.8 5.2H16V25h-4zm4-9h2.2c1.5 0 2.4-.7 2.4-1.8s-.9-1.8-2.4-1.8H16v3.6z"
            fill="#FAF7F2"
          />
        </svg>
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-bold tracking-tight text-brand-dark">
            Privia
          </span>
          <span className="hidden text-sm text-brand-dark/60 sm:inline">
            Confidential invoice financing on Canton
          </span>
        </div>
      </div>
    </header>
  );
}

function PersonaSwitcher({
  persona,
  setPersonaKey,
  busy,
}: {
  persona: Persona;
  setPersonaKey: (k: PersonaKey) => void;
  busy: boolean;
}) {
  return (
    <div className="py-8">
      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label="Acting as party"
      >
        {PERSONAS.map((p) => {
          const active = persona.key === p.key;
          return (
            <button
              key={p.key}
              role="tab"
              aria-selected={active}
              disabled={busy}
              onClick={() => setPersonaKey(p.key)}
              style={active ? { backgroundColor: p.accent } : undefined}
              className={`min-h-10 cursor-pointer rounded-full px-5 py-2.5 text-sm font-semibold transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:opacity-50 ${
                active
                  ? "text-white shadow-sm"
                  : "bg-white text-brand-dark/70 ring-1 ring-brand-dark/10 hover:text-brand-dark hover:ring-brand-dark/30"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div
        className="mt-4 flex items-center gap-3 rounded-2xl border-l-4 bg-white px-4 py-3 shadow-sm"
        style={{ borderLeftColor: persona.accent }}
      >
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-bold text-white"
          style={{ backgroundColor: persona.accent }}
        >
          {persona.label[0]}
        </span>
        <div>
          <div className="text-sm font-bold text-brand-dark">
            Acting as {persona.label}
            <span className="ml-2 font-normal text-brand-dark/50">
              {persona.role}
            </span>
          </div>
          <p className="text-sm text-brand-dark/60">
            You are viewing the ledger as {persona.label}. You see only what
            this party is authorized to see.
          </p>
        </div>
      </div>
    </div>
  );
}

function LifecycleTracker({
  deals,
}: {
  deals: { invoiceId: string; stage: number }[];
}) {
  const focused = deals[0];
  return (
    <div className="mt-6 rounded-2xl border border-brand-dark/10 bg-white px-5 py-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-brand-dark/50">
          Deal lifecycle
        </span>
        <span className="font-mono text-xs text-brand-dark/60">
          {focused.invoiceId}
        </span>
      </div>
      <ol className="flex items-center gap-1" aria-label="Invoice lifecycle">
        {STAGES.map((label, i) => {
          const reached = i < focused.stage;
          const current = i === focused.stage - 1;
          return (
            <li key={label} className="flex flex-1 items-center gap-1 last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 rounded-full transition-colors duration-100 ${
                    reached ? "bg-brand" : "bg-brand-dark/15"
                  } ${current ? "ring-4 ring-brand/20" : ""}`}
                />
                <span
                  className={`whitespace-nowrap text-[11px] font-medium ${
                    reached ? "text-brand-dark" : "text-brand-dark/40"
                  }`}
                >
                  {label}
                  {current && <span className="sr-only"> (current stage)</span>}
                </span>
              </div>
              {i < STAGES.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`mb-5 h-px flex-1 ${
                    i < focused.stage - 1 ? "bg-brand" : "bg-brand-dark/10"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function RejectionBanner() {
  return (
    <div
      role="alert"
      className="enter-banner mb-6 overflow-hidden rounded-2xl bg-brand-dark shadow-lg"
    >
      <div className="flex items-start gap-4 px-6 py-5">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-alert text-lg font-bold text-white"
        >
          ✕
        </span>
        <div>
          <div className="text-xs font-bold uppercase tracking-widest text-alert">
            Transaction rejected by the ledger
          </div>
          <div className="mt-1 text-xl font-bold text-white">
            Double-financing blocked.
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/80">
            This offer referenced an invoice the ledger already consumed when a
            competing offer was accepted. The same receivable cannot be sold
            twice — not because a rule checked for it, but because the contract
            no longer exists.
          </p>
        </div>
      </div>
    </div>
  );
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="enter-banner mb-6 flex items-center gap-3 rounded-2xl border border-brand/25 bg-brand-soft px-5 py-3.5"
    >
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white"
      >
        ✓
      </span>
      <span className="text-sm font-medium text-brand-dark">{message}</span>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="enter-banner mb-6 rounded-2xl border border-alert/30 bg-white px-5 py-3.5 text-sm text-brand-dark"
    >
      <span className="font-semibold text-alert">Ledger error.</span> {message}{" "}
      <span className="text-brand-dark/60">
        Try the action again; if it persists, check the sandbox is running.
      </span>
    </div>
  );
}

function PrivacyStrip({
  persona,
  groups,
}: {
  persona: Persona;
  groups: Partial<Record<TemplateKey, ActiveContract[]>>;
}) {
  const count = (k: TemplateKey) => groups[k]?.length ?? 0;
  const visible = (
    [
      ["Invoice", "invoice"],
      ["AcknowledgedInvoice", "confirmed receivable"],
      ["FinancingOffer", "financing offer"],
      ["FinancedReceivable", "financed receivable"],
      ["Cash", "cash holding"],
    ] as [TemplateKey, string][]
  )
    .filter(([k]) => count(k) > 0)
    .map(([k, label]) => `${count(k)} ${label}${count(k) > 1 ? "s" : ""}`);

  const hidden: Record<PersonaKey, string> = {
    Supplier:
      "financiers' books and quotes they haven't sent you, the buyer's other liabilities.",
    Buyer:
      "financing offers and advance terms — the supplier's funding costs are not the buyer's business.",
    FinancierA:
      "Financier B's competing offers and terms, the supplier's other receivables and cash.",
    FinancierB:
      "Financier A's competing offers and terms, the supplier's other receivables and cash.",
  };

  return (
    <div className="rounded-2xl bg-brand-dark px-5 py-4 text-sm leading-relaxed text-white/85">
      <span className="font-semibold text-white">
        {persona.label}&apos;s ledger holds:
      </span>{" "}
      {visible.length > 0 ? visible.join(", ") : "nothing yet"}.{" "}
      <span className="text-white/55">
        Structurally invisible from here: {hidden[persona.key]}
      </span>
    </div>
  );
}

function EmptyState({ persona }: { persona: Persona }) {
  return (
    <div className="rounded-2xl border border-dashed border-brand-dark/20 bg-white/60 px-6 py-12 text-center">
      <div
        aria-hidden="true"
        className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full text-white"
        style={{ backgroundColor: persona.accent }}
      >
        {persona.label[0]}
      </div>
      <p className="mx-auto max-w-md text-sm text-brand-dark/60">{persona.empty}</p>
    </div>
  );
}

function SkeletonView() {
  return (
    <div aria-hidden="true" className="space-y-6">
      <div className="h-13 animate-pulse rounded-2xl bg-brand-dark/8" />
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-44 animate-pulse rounded-2xl border border-brand-dark/5 bg-white"
          />
        ))}
      </div>
      <span className="sr-only">Loading this party&apos;s ledger view</span>
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
  const items = Array.isArray(children)
    ? children.flat().filter(Boolean)
    : [children];
  const empty =
    items.length === 0 || (Array.isArray(items[0]) && items[0].length === 0);
  if (empty) return null;
  return (
    <section>
      <div className="mb-4 flex items-baseline gap-3">
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

function CardTitle({
  title,
  badge,
  amount,
}: {
  title: string;
  badge: string;
  amount: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold text-brand-dark">{title}</div>
        <div className="whitespace-nowrap rounded-lg bg-brand-soft px-2.5 py-1 font-mono text-sm font-bold tabular-nums text-brand">
          {amount}
        </div>
      </div>
      <span className="mt-1 inline-block rounded-full bg-brand-dark/5 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-brand-dark/60">
        {badge}
      </span>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-t border-brand-dark/5 py-1.5 text-sm">
      <span className="text-brand-dark/50">{k}</span>
      <span className="text-right font-medium text-brand-dark">{v}</span>
    </div>
  );
}

const buttonBase =
  "min-h-10 cursor-pointer rounded-xl text-sm font-semibold text-white transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-white active:translate-y-px disabled:cursor-default disabled:opacity-40";

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
      aria-busy={busy}
      className={`${buttonBase} mt-4 w-full bg-brand px-4 py-2.5 hover:bg-brand/90`}
    >
      {busy ? "Submitting…" : label}
    </button>
  );
}

function OfferForm({
  busy,
  faceAmount,
  currency,
  onOffer,
}: {
  busy: boolean;
  faceAmount: string;
  currency: string;
  onOffer: (amount: string) => void;
}) {
  const [amount, setAmount] = useState(
    (parseFloat(faceAmount) * 0.95).toFixed(2),
  );
  return (
    <form
      className="mt-4 flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onOffer(amount);
      }}
    >
      <label className="text-xs font-medium text-brand-dark/70">
        Advance ({currency})
        <input
          type="number"
          step="0.01"
          min="0.01"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mt-1 block w-32 rounded-xl border border-brand-dark/15 bg-white px-3 py-2 font-mono text-sm tabular-nums text-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className={`${buttonBase} flex-1 bg-brand px-4 py-2.5 hover:bg-brand/90`}
      >
        {busy ? "Submitting…" : "Make offer"}
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

  const inputCls =
    "mt-1 block rounded-xl border border-brand-dark/15 bg-white px-3 py-2 text-sm text-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

  return (
    <section className="rounded-2xl border border-brand/25 bg-brand-soft/50 p-5">
      <h2 className="mb-3 text-base font-bold text-brand-dark">
        Issue an invoice
      </h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <label className="text-xs font-medium text-brand-dark/70">
          Invoice ID
          <input
            required
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            placeholder="INV-002"
            className={`${inputCls} w-36`}
          />
        </label>
        <label className="text-xs font-medium text-brand-dark/70">
          Amount
          <input
            type="number"
            step="0.01"
            min="0.01"
            required
            value={faceAmount}
            onChange={(e) => setFaceAmount(e.target.value)}
            className={`${inputCls} w-28 font-mono tabular-nums`}
          />
        </label>
        <label className="text-xs font-medium text-brand-dark/70">
          Currency
          <input
            required
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className={`${inputCls} w-20`}
          />
        </label>
        <label className="text-xs font-medium text-brand-dark/70">
          Due date
          <input
            type="date"
            required
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs font-medium text-brand-dark/70">
          Buyer
          <input
            disabled
            value={buyers[0]?.displayName ?? "—"}
            className="mt-1 block w-24 rounded-xl border border-brand-dark/10 bg-brand-dark/5 px-3 py-2 text-sm text-brand-dark/60"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !buyer}
          aria-busy={busy}
          className={`${buttonBase} bg-brand px-5 py-2.5 hover:bg-brand/90`}
        >
          {busy ? "Submitting…" : "Issue invoice"}
        </button>
      </form>
      <p className="mt-3 text-xs text-brand-dark/50">
        Invited to bid once the buyer confirms:{" "}
        {financiers.map((f) => f.displayName).join(", ") ||
          "no financiers found"}
        . They see nothing until acknowledgment.
      </p>
    </section>
  );
}
