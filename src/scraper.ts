/**
 * Scraper for the Polish KRS (Krajowy Rejestr Sądowy) National Court Register.
 *
 * Source: https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/{KRS}?rejestr={P|S}&format=json
 * (Public OpenAPI operated by the Polish Ministry of Justice — no auth, no listing
 * endpoint, lookup-by-KRS-number only. We sweep numerically from the highest stored
 * KRS number and try the two main register sections — P (entrepreneurs) and S
 * (associations / non-profits). The U section is for insolvent debtors and is not
 * exposed via OpenAPI.)
 */

export interface Env {
  DB: D1Database;
}

interface KRSCompany {
  krs_number: string;
  name: string | null;
  nip: string | null;
  regon: string | null;
  legal_form: string | null;
  registry_type: string | null;
  registration_date: string | null;
  address: string | null;
  status: string | null;
  last_entry_date: string | null;
}

const BASE_URL = "https://api-krs.ms.gov.pl/api/krs/OdpisAktualny";
const REGISTRY_TYPES = ["P", "S"] as const;
const PAGE_SIZE = 20;
const MAX_PAGES = 50;
const FETCH_TIMEOUT_MS = 8_000;

const UPSERT_SQL = `
INSERT INTO companies (
  krs_number, name, nip, regon, legal_form,
  registry_type, registration_date, address, status, last_entry_date
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(krs_number) DO UPDATE SET
  name              = excluded.name,
  nip               = excluded.nip,
  regon             = excluded.regon,
  legal_form        = excluded.legal_form,
  registry_type     = excluded.registry_type,
  registration_date = excluded.registration_date,
  address           = excluded.address,
  status            = excluded.status,
  last_entry_date   = excluded.last_entry_date
`;

// ---------- safe JSON traversal helpers (no `any`) ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function pickString(root: unknown, path: readonly string[]): string | null {
  const v = pick(root, path);
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------- parsing ----------

function formatAddress(siedzibaIAdres: unknown): string | null {
  const street = pickString(siedzibaIAdres, ["adres", "ulica"]);
  const houseNo = pickString(siedzibaIAdres, ["adres", "nrDomu"]);
  const flatNo = pickString(siedzibaIAdres, ["adres", "nrLokalu"]);
  const postal = pickString(siedzibaIAdres, ["adres", "kodPocztowy"]);
  const city =
    pickString(siedzibaIAdres, ["adres", "miejscowosc"]) ??
    pickString(siedzibaIAdres, ["siedziba", "miejscowosc"]);
  const voivodeship = pickString(siedzibaIAdres, ["siedziba", "wojewodztwo"]);
  const country = pickString(siedzibaIAdres, ["adres", "kraj"]);

  const streetLine = [street, houseNo].filter((x): x is string => !!x).join(" ");
  const streetWithFlat = flatNo ? `${streetLine}/${flatNo}` : streetLine;
  const cityLine = [postal, city].filter((x): x is string => !!x).join(" ");

  const parts = [streetWithFlat, cityLine, voivodeship, country].filter(
    (x): x is string => !!x && x.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function deriveStatus(odpis: unknown): string {
  // dzial6 contains liquidation, bankruptcy, restructuring and deletion entries.
  const dzial6 = pick(odpis, ["dane", "dzial6"]);
  if (isObj(dzial6)) {
    if (dzial6["wykreslenie"]) return "deleted";
    if (dzial6["postepowanieUpadlosciowe"]) return "bankrupt";
    if (dzial6["likwidacja"] || dzial6["informacjaORozwiazaniu"])
      return "in_liquidation";
  }
  // Header-level deletion flag.
  const deletedFlag = pick(odpis, ["naglowekA", "wykreslony"]);
  if (deletedFlag === true || deletedFlag === "TAK") return "deleted";
  return "active";
}

function parseCompany(
  krs: string,
  registry: string,
  raw: unknown,
): KRSCompany | null {
  const odpis = pick(raw, ["odpis"]);
  if (!isObj(odpis)) return null;

  const podmiot = pick(odpis, ["dane", "dzial1", "danePodmiotu"]);
  const siedziba = pick(odpis, ["dane", "dzial1", "siedzibaIAdres"]);
  const naglowek = pick(odpis, ["naglowekA"]);

  // Legal form may live under nazwa or formaPrawna depending on registry section.
  const legalForm =
    pickString(podmiot, ["formaPrawna"]) ??
    pickString(podmiot, ["formaPrawnaNazwa"]) ??
    pickString(podmiot, ["nazwa", "formaPrawna"]);

  const name =
    pickString(podmiot, ["nazwa"]) ??
    pickString(podmiot, ["nazwaPodmiotu"]) ??
    pickString(podmiot, ["nazwaSkrocona"]);

  if (!name) return null; // empty / placeholder slot

  return {
    krs_number: krs,
    name,
    nip:
      pickString(podmiot, ["identyfikatory", "nip"]) ??
      pickString(podmiot, ["nip"]),
    regon:
      pickString(podmiot, ["identyfikatory", "regon"]) ??
      pickString(podmiot, ["regon"]),
    legal_form: legalForm,
    registry_type: registry,
    registration_date:
      pickString(naglowek, ["dataRejestracjiWKrs"]) ??
      pickString(podmiot, ["dataRejestracjiWKRS"]) ??
      pickString(naglowek, ["dataRejestracji"]),
    address: formatAddress(siedziba),
    status: deriveStatus(odpis),
    last_entry_date:
      pickString(naglowek, ["dataDokonaniaWpisu"]) ??
      pickString(naglowek, ["dataOstatniegoWpisu"]),
  };
}

// ---------- fetching ----------

async function fetchKrs(krs: string, registry: string): Promise<unknown | null> {
  const url = `${BASE_URL}/${krs}?rejestr=${registry}&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[scraper] ${krs}/${registry} HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    if (!text || text.length < 2) return null;
    return JSON.parse(text) as unknown;
  } catch (err) {
    console.warn(`[scraper] fetch error ${krs}/${registry}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(krs: string): Promise<KRSCompany | null> {
  for (const reg of REGISTRY_TYPES) {
    const raw = await fetchKrs(krs, reg);
    if (raw === null) continue;
    const parsed = parseCompany(krs, reg, raw);
    if (parsed) return parsed;
  }
  return null;
}

// ---------- driver ----------

async function readCursor(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT MAX(CAST(krs_number AS INTEGER)) AS max_krs FROM companies",
    ).first<{ max_krs: number | null }>();
    return row?.max_krs ?? 0;
  } catch (err) {
    console.warn("[scraper] could not read cursor, starting from 1:", err);
    return 0;
  }
}

export async function runScraper(env: Env): Promise<void> {
  console.log("[scraper] KRS scraper starting");

  const cursor = await readCursor(env);
  console.log(`[scraper] cursor=${cursor}, page_size=${PAGE_SIZE}, max_pages=${MAX_PAGES}`);

  let totalFetched = 0;
  let totalUpserted = 0;
  let totalChanged = 0;
  let consecutiveEmptyPages = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = cursor + 1 + page * PAGE_SIZE;
    const krsList: string[] = [];
    for (let i = 0; i < PAGE_SIZE; i++) {
      krsList.push(String(start + i).padStart(10, "0"));
    }

    let companies: KRSCompany[];
    try {
      const settled = await Promise.all(krsList.map((k) => fetchOne(k)));
      companies = settled.filter((c): c is KRSCompany => c !== null);
    } catch (err) {
      console.error(`[scraper] page ${page} fetch failed:`, err);
      continue;
    }

    totalFetched += companies.length;

    if (companies.length === 0) {
      consecutiveEmptyPages++;
      // If we hit 5 wholly empty pages in a row we've likely walked off the end
      // of the assigned KRS numbering range — stop early to save subrequests.
      if (consecutiveEmptyPages >= 5) {
        console.log(`[scraper] ${consecutiveEmptyPages} empty pages; stopping early at page ${page}`);
        break;
      }
      continue;
    }
    consecutiveEmptyPages = 0;

    try {
      const stmts = companies.map((c) =>
        env.DB.prepare(UPSERT_SQL).bind(
          c.krs_number,
          c.name,
          c.nip,
          c.regon,
          c.legal_form,
          c.registry_type,
          c.registration_date,
          c.address,
          c.status,
          c.last_entry_date,
        ),
      );
      const results = await env.DB.batch(stmts);
      for (const r of results) {
        if (r.success) {
          totalUpserted++;
          const changes = r.meta?.changes;
          if (typeof changes === "number") totalChanged += changes;
        }
      }
    } catch (err) {
      console.error(`[scraper] page ${page} batch upsert failed:`, err);
      // continue — next page may still succeed
    }
  }

  console.log(
    `[scraper] done fetched=${totalFetched} upserted=${totalUpserted} changed=${totalChanged}`,
  );
}