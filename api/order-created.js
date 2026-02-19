
// api/order-created.js
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Pool } from 'pg';

// ---------- Singletons (created outside handler for perf) ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// IMPORTANT:
// Use ONE Pool everywhere, and include the CA cert so pg trusts Supabase.
// This avoids: "self-signed certificate in certificate chain" [1](https://supabase.com/docs)[2](https://supabase.com/docs/guides/database/prisma/prisma-troubleshooting)


function getDatabaseCa() {
  const b64 = process.env.DATABASE_CA_B64 || '';
  return Buffer.from(b64, 'base64').toString('utf-8').trim();
}


const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    ca: getDatabaseCa(),
    rejectUnauthorized: true,
  },
});


// Helper: download remote file to Buffer (uses global fetch on Vercel)
async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// Find the artwork link from Shopify line-item properties
function getArtworkProperty(lineItem) {
  // Shopify stores properties like: [{ name: "Artwork PDF", value: "<url>" }, ...]
  const props = lineItem?.properties ?? [];
  const pdfProp =
    props.find(p => /artwork pdf/i.test(p.name)) ||
    props.find(p => /artwork/i.test(p.name)) ||
    props.find(p => /file/i.test(p.name));
  return pdfProp?.value ?? null; // may be a URL
}

// Collect a simple, human-readable options map (you can customize this later)
function collectSelectedOptions(lineItem) {
  // Example: "3.5x2 / 16pt / Matte / 2 Sides"
  const opts = {};
  (lineItem?.variant_title ?? '').split(' / ').forEach((val, idx) => {
    if (val) opts[`option_${idx + 1}`] = val;
  });
  return opts;
}

// Verify Shopify webhook HMAC
function verifyShopifyHmac(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET ?? '')
    .update(rawBody)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(hmacHeader ?? '', 'utf8')
    );
  } catch {
    return false;
  }
}

// Tell Vercel not to parse the body so we can verify the exact bytes
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    // Read raw bytes for HMAC verification
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    // Verify Shopify signature
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      return res.status(401).send('Invalid HMAC');
    }

    // Parse order JSON
    const order = JSON.parse(rawBody.toString('utf8'));

    // (Optional) upsert into your orders table for traceability
    await db.query(
      `INSERT INTO orders (shopify_order_id, raw)
       VALUES ($1, $2)
       ON CONFLICT (shopify_order_id) DO NOTHING`,
      [String(order.id), order]
    );

    // Process each line item
    for (const li of order.line_items ?? []) {
      const lineItemId = String(li.id);
      const quantity = li.quantity;
      const variantId = li.variant_id ? String(li.variant_id) : null;

      // 1) Artwork URL from line-item properties
      const artworkUrlFromShopify = getArtworkProperty(li);

      // 2) If present, download & re-upload with our naming rule
      let finalArtworkUrl = null;
      if (artworkUrlFromShopify) {
        const pdfBuf = await downloadToBuffer(artworkUrlFromShopify);
        const objectPath = `artwork/LI_${lineItemId}.pdf`; // your convention

        const { error: upErr } = await supabase.storage
          .from('artwork')
          .upload(objectPath, pdfBuf, {
            contentType: 'application/pdf',
            upsert: true,
          });

        if (upErr) throw upErr;

        const { data } = supabase.storage.from('artwork').getPublicUrl(objectPath);
        finalArtworkUrl = data.publicUrl; // permanent public link
      }

      // 3) Capture the selected options for later mapping/debugging
      const selected_options = collectSelectedOptions(li);

      // 4) Resolve SinaLite product mapping (placeholder — wire your real mapping later)
      const sinalite_product_id = li.vendor ?? 'UNKNOWN';

      // 5) Insert the line_items row
      await db.query(
        `INSERT INTO line_items
         (shopify_order_id, shopify_line_item_id, shopify_variant_id,
          sinalite_product_id, selected_options, quantity, artwork_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (shopify_line_item_id) DO NOTHING`,
        [
          String(order.id),
          lineItemId,
          variantId,
          String(sinalite_product_id),
          selected_options,
          quantity,
          finalArtworkUrl, // may be null if no file was uploaded
          'pending',
        ]
      );
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error(err);
    return res.status(500).send('error');
  }
}
