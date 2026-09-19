/**
 * 50 deterministic invoice emails for the "Do it twice" demo. Everything here is fictional.
 * Generated once at module load from a seeded PRNG, so every page load, tab, iframe, and test sees the same data.
 */
export interface InvoiceEmail {
  /** "INV-1001" .. "INV-1050". Also the invoice number. */
  id: string;
  number: string;
  vendor: string;
  senderName: string;
  senderEmail: string;
  /** ISO calendar dates (yyyy-mm-dd). */
  date: string;
  dueDate: string;
  /** Local wall-clock time the email arrived, "yyyy-mm-ddThh:mm". */
  receivedAt: string;
  description: string;
  subtotalCents: number;
  taxRate: number;
  taxCents: number;
  totalCents: number;
  subject: string;
  body: string;
}

export const INVOICE_COUNT = 50;
/** Chosen so all 20 vendors appear, every total is unique, and INV-1007 is from Brightwave Supply (the example used in the docs). */
export const INVOICE_SEED = 20261026;
const FIRST_NUMBER = 1001;
const NEWEST_DATE = "2026-09-17";
const TERMS_DAYS = 30;
const TAX_RATES = [0.05, 0.0625, 0.07, 0.0825, 0.13] as const;

interface Vendor {
  name: string;
  contact: string;
  services: readonly string[];
}

const VENDORS: readonly Vendor[] = [
  { name: "Brightwave Supply", contact: "Marisol", services: ["Packing materials restock", "Shelf labels and tape", "Warehouse consumables"] },
  { name: "Harbor Lane Logistics", contact: "Devon", services: ["Regional freight, 3 pallets", "Last-mile delivery batch", "Storage fees"] },
  { name: "Quillfeather Print Co.", contact: "Anneke", services: ["Brochure print run", "Business cards, 500 count", "Trade show banner"] },
  { name: "Tamarack Office Goods", contact: "Joss", services: ["Desk chairs, 4 units", "Printer toner and paper", "Whiteboards and markers"] },
  { name: "Bluefinch Catering", contact: "Priyanka", services: ["Team lunch, 24 people", "Client breakfast service", "Quarterly all-hands catering"] },
  { name: "Ironleaf Hardware", contact: "Tobias", services: ["Fasteners and brackets", "Hand tool replacement", "Safety gloves and goggles"] },
  { name: "Mossgate Landscaping", contact: "Wren", services: ["Monthly grounds maintenance", "Seasonal planting", "Irrigation repair"] },
  { name: "Lanternhill Cleaning", contact: "Odalys", services: ["Monthly office cleaning", "Carpet deep clean", "Window washing"] },
  { name: "Copperline Electric", contact: "Matteo", services: ["Lighting retrofit, phase 2", "Panel inspection", "Outlet installation"] },
  { name: "Saltmarsh Coffee Roasters", contact: "Ingrid", services: ["Office coffee subscription", "Espresso machine service", "Decaf and tea restock"] },
  { name: "Verdant Loop Recycling", contact: "Kofi", services: ["Monthly recycling pickup", "E-waste collection", "Secure paper shredding"] },
  { name: "Swiftkite Courier", contact: "Leila", services: ["Same-day courier runs", "Document delivery, 12 stops", "Overnight parcel batch"] },
  { name: "Oakhollow Furniture", contact: "Bram", services: ["Standing desks, 3 units", "Conference table", "Lobby seating"] },
  { name: "Pixelbarn Studios", contact: "Sunniva", services: ["Product photo shoot", "Explainer video edit", "Icon set design"] },
  { name: "Ridgewater Plumbing", contact: "Emeka", services: ["Kitchen sink repair", "Water heater service", "Backflow test"] },
  { name: "Sunmill Paper Goods", contact: "Talia", services: ["Shipping boxes, 400 count", "Kraft mailers", "Notebooks for onboarding kits"] },
  { name: "Thistledown Textiles", contact: "Ravi", services: ["Branded tote bags", "Staff uniforms", "Event tablecloths"] },
  { name: "Umberfield Security", contact: "Cassia", services: ["Alarm monitoring, quarterly", "Badge reader install", "Camera maintenance"] },
  { name: "Wrenfold IT Services", contact: "Halvard", services: ["Managed backups, monthly", "Laptop setup, 5 devices", "Network audit"] },
  { name: "Yarrowfinch Consulting", contact: "Noor", services: ["Process review workshop", "Quarterly advisory retainer", "Hiring plan review"] },
];

/** Small, fast, well-distributed PRNG. Deterministic for a given seed on every JS engine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBelow(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Calendar-date arithmetic in UTC so the result never depends on the machine's time zone. */
export function addDays(iso: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-09-03" -> "Sep 3, 2026" */
export function formatDate(iso: string): string {
  const [y = 1970, m = 1, d = 1] = iso.slice(0, 10).split("-").map(Number);
  return `${MONTHS[m - 1] ?? "Jan"} ${d}, ${y}`;
}

/** "2026-09-03T09:14" -> "Sep 3, 2026, 9:14 AM" */
export function formatDateTime(local: string): string {
  const [hh = 0, mm = 0] = (local.split("T")[1] ?? "00:00").split(":").map(Number);
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${formatDate(local)}, ${hour12}:${pad2(mm)} ${hh < 12 ? "AM" : "PM"}`;
}

/** 120450 -> "$1,204.50" */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${pad2(abs % 100)}`;
}

/** 0.0825 -> "8.25%" */
export function formatRate(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

function emailDomain(vendor: string): string {
  const slug = vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug}.example.com`;
}

function pickVendor(rand: () => number, previous: Vendor | undefined): Vendor {
  // Never the same vendor twice in a row, so two consecutive invoices always differ in every logged column.
  for (;;) {
    const vendor = VENDORS[intBelow(rand, VENDORS.length)];
    if (vendor && vendor !== previous) return vendor;
  }
}

function bodyFor(id: string, vendor: Vendor, description: string): string {
  return [
    "Hi Alex,",
    `Thanks for working with ${vendor.name}. Invoice ${id} is below. It covers: ${description.toLowerCase()}. Payment terms are net ${TERMS_DAYS}.`,
    "Please reply to confirm you received it.",
    `${vendor.contact}\n${vendor.name} Billing`,
  ].join("\n\n");
}

export function generateInvoices(seed: number = INVOICE_SEED, count: number = INVOICE_COUNT): InvoiceEmail[] {
  const rand = mulberry32(seed);
  const invoices: InvoiceEmail[] = [];
  let date = NEWEST_DATE;
  let previous: Vendor | undefined;
  for (let i = 0; i < count; i++) {
    const vendor = pickVendor(rand, previous);
    previous = vendor;
    const id = `INV-${FIRST_NUMBER + i}`;
    const description = vendor.services[intBelow(rand, vendor.services.length)] ?? "Services rendered";
    // Squared so most invoices are a few hundred dollars and a healthy share cross $1,000.
    const subtotalCents = Math.round((45 + rand() ** 2 * 4750) * 100);
    const taxRate = TAX_RATES[intBelow(rand, TAX_RATES.length)] ?? 0.05;
    const taxCents = Math.max(1, Math.round(subtotalCents * taxRate));
    if (i > 0) date = addDays(date, -intBelow(rand, 3)); // the inbox is newest first
    const receivedAt = `${date}T${pad2(8 + intBelow(rand, 10))}:${pad2(intBelow(rand, 60))}`;
    invoices.push({
      id,
      number: id,
      vendor: vendor.name,
      senderName: `${vendor.name} Billing`,
      senderEmail: `billing@${emailDomain(vendor.name)}`,
      date,
      dueDate: addDays(date, TERMS_DAYS),
      receivedAt,
      description,
      subtotalCents,
      taxRate,
      taxCents,
      totalCents: subtotalCents + taxCents,
      subject: `Invoice ${id} from ${vendor.name}`,
      body: bodyFor(id, vendor, description),
    });
  }
  return invoices;
}

export const INVOICES: readonly InvoiceEmail[] = generateInvoices();
export const VENDOR_NAMES: readonly string[] = VENDORS.map((v) => v.name);

const BY_ID = new Map(INVOICES.map((invoice) => [invoice.id, invoice]));

export function findInvoice(id: string): InvoiceEmail | undefined {
  return BY_ID.get(id.trim().toUpperCase());
}

/** The exact strings the invoice page shows, keyed by the `data-field` attribute that carries them. */
export interface InvoiceDisplay {
  vendor: string;
  number: string;
  date: string;
  due: string;
  description: string;
  subtotal: string;
  "tax-rate": string;
  tax: string;
  total: string;
}

export function displayFields(invoice: InvoiceEmail): InvoiceDisplay {
  return {
    vendor: invoice.vendor,
    number: invoice.number,
    date: formatDate(invoice.date),
    due: formatDate(invoice.dueDate),
    description: invoice.description,
    subtotal: formatMoney(invoice.subtotalCents),
    "tax-rate": formatRate(invoice.taxRate),
    tax: formatMoney(invoice.taxCents),
    total: formatMoney(invoice.totalCents),
  };
}

/** What a correctly logged sheet row looks like when the values are copied as displayed: Vendor, Invoice #, Date, Total. */
export function expectedSheetRow(invoice: InvoiceEmail): [string, string, string, string] {
  const shown = displayFields(invoice);
  return [shown.vendor, shown.number, shown.date, shown.total];
}
