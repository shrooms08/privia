"use client";

// Diagnostic smoke page: proves party discovery and per-party ACS reads work
// in-browser through the /ledger-api proxy. Not the product UI.

import { useEffect, useState } from "react";
import {
  ActiveContract,
  LedgerApiError,
  listParties,
  PartyInfo,
  queryActiveContracts,
  templateKeyOf,
} from "@/lib/ledger";

export default function SmokePage() {
  const [parties, setParties] = useState<PartyInfo[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [contracts, setContracts] = useState<ActiveContract[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listParties()
      .then(setParties)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!selected) {
      setContracts(null);
      return;
    }
    setLoading(true);
    setError(null);
    queryActiveContracts(selected)
      .then(setContracts)
      .catch((e) =>
        setError(e instanceof LedgerApiError ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }, [selected]);

  return (
    <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-xl font-bold">Privia — ledger smoke test</h1>
      <p className="mb-6 text-gray-500">
        JSON Ledger API via /ledger-api proxy · diagnostic page
      </p>

      <section className="mb-6">
        <h2 className="mb-2 font-bold">Parties ({parties.length})</h2>
        <ul className="mb-3 space-y-1">
          {parties.map((p) => (
            <li key={p.partyId}>
              <span className="font-bold">{p.displayName}</span>{" "}
              <span className="break-all text-gray-500">{p.partyId}</span>
            </li>
          ))}
        </ul>
        <label>
          View ledger as:{" "}
          <select
            className="rounded border px-2 py-1"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">— pick a party —</option>
            {parties.map((p) => (
              <option key={p.partyId} value={p.partyId}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && (
        <pre className="mb-4 whitespace-pre-wrap rounded border border-red-400 bg-red-50 p-3 text-red-700">
          {error}
        </pre>
      )}
      {loading && <p>querying ACS…</p>}

      {contracts && !loading && (
        <section>
          <h2 className="mb-2 font-bold">
            Active contracts visible to {selected.split("::")[0]}:{" "}
            {contracts.length}
          </h2>
          {contracts.length === 0 && (
            <p className="text-gray-500">
              (none — this party sees nothing on the ledger)
            </p>
          )}
          <div className="space-y-3">
            {contracts.map((c) => (
              <div key={c.contractId} className="rounded border p-3">
                <div className="font-bold">
                  {templateKeyOf(c.templateId) ?? c.templateId}
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-all text-xs text-gray-600">
                  {JSON.stringify(c.payload, null, 2)}
                </pre>
                <div className="mt-1 break-all text-xs text-gray-400">
                  cid: {c.contractId}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
