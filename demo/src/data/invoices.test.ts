import { describe, expect, it } from "vitest";
import {
  INVOICES, INVOICE_COUNT, VENDOR_NAMES, addDays, displayFields, expectedSheetRow, findInvoice, formatDate, formatDateTime,
  formatMoney, formatRate, generateInvoices, mulberry32,
} from "./invoices";

describe("seeded invoices", () => {
  it("generates the same 50 invoices every time", () => {
    expect(INVOICES).toHaveLength(INVOICE_COUNT);
    expect(generateInvoices()).toEqual(INVOICES);
    expect(generateInvoices()).toEqual(generateInvoices());
  });

  it("changes with the seed", () => {
    expect(generateInvoices(7)).not.toEqual(INVOICES);
    expect(mulberry32(1)()).toBe(mulberry32(1)());
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it("numbers them INV-1001 to INV-1050 with the number equal to the id", () => {
    expect(INVOICES[0]?.id).toBe("INV-1001");
    expect(INVOICES[49]?.id).toBe("INV-1050");
    INVOICES.forEach((invoice, i) => {
      expect(invoice.id).toBe(`INV-${1001 + i}`);
      expect(invoice.number).toBe(invoice.id);
    });
  });

  it("reuses about twenty invented vendors and never repeats one back to back", () => {
    const used = new Set(INVOICES.map((invoice) => invoice.vendor));
    expect(VENDOR_NAMES).toHaveLength(20);
    expect(used.size).toBe(20);
    for (const vendor of used) expect(VENDOR_NAMES).toContain(vendor);
    for (let i = 1; i < INVOICES.length; i++) expect(INVOICES[i]?.vendor).not.toBe(INVOICES[i - 1]?.vendor);
  });

  it("builds the subject, sender, and body from the vendor", () => {
    expect(INVOICES[6]?.subject).toBe("Invoice INV-1007 from Brightwave Supply");
    expect(INVOICES[6]?.senderEmail).toBe("billing@brightwave-supply.example.com");
    for (const invoice of INVOICES) {
      expect(invoice.subject).toBe(`Invoice ${invoice.id} from ${invoice.vendor}`);
      expect(invoice.senderEmail).toMatch(/^billing@[a-z0-9-]+\.example\.com$/);
      expect(invoice.body).toContain(invoice.id);
      expect(invoice.body.length).toBeLessThan(400);
    }
  });

  it("keeps totals consistent, with subtotal and tax as real distractors", () => {
    expect(new Set(INVOICES.map((invoice) => invoice.totalCents)).size).toBe(INVOICE_COUNT);
    for (const invoice of INVOICES) {
      expect(Number.isInteger(invoice.totalCents)).toBe(true);
      expect(invoice.taxCents).toBeGreaterThan(0);
      expect(invoice.totalCents).toBe(invoice.subtotalCents + invoice.taxCents);
      const shown = displayFields(invoice);
      expect(new Set([shown.subtotal, shown.tax, shown.total]).size).toBe(3);
      expect(shown.due).not.toBe(shown.date);
    }
  });

  it("formats every total like $1,204.50 and every date like Sep 3, 2026", () => {
    for (const invoice of INVOICES) {
      const shown = displayFields(invoice);
      expect(shown.total).toMatch(/^\$\d{1,3}(,\d{3})*\.\d{2}$/);
      expect(shown.date).toMatch(/^[A-Z][a-z]{2} \d{1,2}, 2026$/);
      expect(invoice.date).toMatch(/^2026-\d{2}-\d{2}$/);
    }
    expect(INVOICES.some((invoice) => invoice.totalCents >= 100000)).toBe(true);
    expect(INVOICES.some((invoice) => invoice.totalCents < 100000)).toBe(true);
  });

  it("orders the inbox newest first and keeps dates in the recent past", () => {
    for (let i = 1; i < INVOICES.length; i++) {
      expect((INVOICES[i]?.date ?? "") <= (INVOICES[i - 1]?.date ?? "")).toBe(true);
    }
    expect(INVOICES[0]?.date).toBe("2026-09-17");
    expect((INVOICES[49]?.date ?? "") > "2026-05-01").toBe(true);
  });

  it("finds invoices by id, forgiving case and whitespace", () => {
    expect(findInvoice("INV-1007")?.id).toBe("INV-1007");
    expect(findInvoice(" inv-1007 ")?.id).toBe("INV-1007");
    expect(findInvoice("INV-1051")).toBeUndefined();
    expect(findInvoice("")).toBeUndefined();
  });

  it("describes the sheet row a correct copy produces", () => {
    const invoice = INVOICES[6]!;
    expect(expectedSheetRow(invoice)).toEqual([invoice.vendor, "INV-1007", formatDate(invoice.date), formatMoney(invoice.totalCents)]);
  });
});

describe("formatters", () => {
  it("formats money from cents", () => {
    expect(formatMoney(120450)).toBe("$1,204.50");
    expect(formatMoney(4500)).toBe("$45.00");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(123456789)).toBe("$1,234,567.89");
    expect(formatMoney(-9900)).toBe("-$99.00");
  });

  it("formats dates without consulting the time zone", () => {
    expect(formatDate("2026-09-03")).toBe("Sep 3, 2026");
    expect(formatDate("2026-12-31")).toBe("Dec 31, 2026");
    expect(formatDateTime("2026-09-03T09:14")).toBe("Sep 3, 2026, 9:14 AM");
    expect(formatDateTime("2026-09-03T12:05")).toBe("Sep 3, 2026, 12:05 PM");
    expect(formatDateTime("2026-09-03T17:40")).toBe("Sep 3, 2026, 5:40 PM");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-09-17", -17)).toBe("2026-08-31");
    expect(addDays("2026-12-15", 30)).toBe("2027-01-14");
    expect(addDays("2026-03-01", 0)).toBe("2026-03-01");
  });

  it("formats tax rates", () => {
    expect(formatRate(0.0825)).toBe("8.25%");
    expect(formatRate(0.13)).toBe("13%");
  });
});
