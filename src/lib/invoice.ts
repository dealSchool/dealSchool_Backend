import PDFDocument from "pdfkit";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

const NAVY = "#082C6C";
const GOLD = "#D4A62A";
const GREY = "#5F6368";
const INK  = "#111111";
const LINE = "#EDE9DE";

// Sequential per-year invoice numbers (INV-2026-0001, INV-2026-0002, ...),
// guarded by a Firestore transaction so concurrent webhook deliveries can't
// hand out the same number twice.
export async function getNextInvoiceNumber(date: Date): Promise<string> {
  const year = date.getFullYear();
  const counterRef = adminDb.collection("counters").doc(`invoice-${year}`);

  const seq = await adminDb.runTransaction(async (t) => {
    const snap = await t.get(counterRef);
    const current = snap.exists ? (snap.data()!.seq as number) : 0;
    const next = current + 1;
    t.set(counterRef, { seq: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return next;
  });

  return `INV-${year}-${String(seq).padStart(4, "0")}`;
}

export interface InvoiceData {
  invoiceNumber: string;
  applicantName: string;
  applicantEmail: string;
  amountDisplay: string;
  paymentDate: Date;
  paymentMethod: string;
  paymentId: string;
}

export function generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const formattedDate = data.paymentDate.toLocaleDateString("en-IN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Header
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(22).text("DealSchool", 50, 50);
    doc.fillColor(GREY).font("Helvetica").fontSize(9).text("Venture Fellowship", 50, 76);

    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(16).text("INVOICE", 350, 50, { width: 195, align: "right" });
    doc
      .fillColor(GREY)
      .font("Helvetica")
      .fontSize(10)
      .text(`Invoice #: ${data.invoiceNumber}`, 350, 76, { width: 195, align: "right" })
      .text(`Date: ${formattedDate}`, 350, 90, { width: 195, align: "right" });

    doc.moveTo(50, 115).lineTo(545, 115).strokeColor(GOLD).lineWidth(2).stroke();

    // Billed to
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Billed To", 50, 140);
    doc
      .fillColor(INK)
      .font("Helvetica")
      .fontSize(11)
      .text(data.applicantName, 50, 158)
      .fillColor(GREY)
      .fontSize(10)
      .text(data.applicantEmail, 50, 174);

    // Line item
    const tableTop = 220;
    doc
      .fillColor(GREY)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text("DESCRIPTION", 50, tableTop)
      .text("AMOUNT", 450, tableTop, { width: 95, align: "right" });
    doc.moveTo(50, tableTop + 16).lineTo(545, tableTop + 16).strokeColor(LINE).lineWidth(1).stroke();

    doc
      .fillColor(INK)
      .font("Helvetica")
      .fontSize(11)
      .text("DealSchool Fellowship Program Fee", 50, tableTop + 26)
      .text(data.amountDisplay, 450, tableTop + 26, { width: 95, align: "right" });

    doc.moveTo(50, tableTop + 55).lineTo(545, tableTop + 55).strokeColor(LINE).lineWidth(1).stroke();

    doc
      .fillColor(NAVY)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("Total Paid", 350, tableTop + 70, { width: 100, align: "right" })
      .text(data.amountDisplay, 450, tableTop + 70, { width: 95, align: "right" });

    // Payment details
    const payTop = tableTop + 120;
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Payment Details", 50, payTop);
    doc
      .fillColor(GREY)
      .font("Helvetica")
      .fontSize(10)
      .text(`Payment ID: ${data.paymentId}`, 50, payTop + 20)
      .text(`Payment Method: ${data.paymentMethod}`, 50, payTop + 36)
      .text("Status: Paid", 50, payTop + 52);

    // Footer
    doc
      .fillColor(GREY)
      .font("Helvetica")
      .fontSize(9)
      .text("DealSchool  ·  support@dealschool.in", 50, 760, { width: 495, align: "center" });

    doc.end();
  });
}
