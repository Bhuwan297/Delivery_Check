const Anthropic = require("@anthropic-ai/sdk");

const CATEGORIES = [
  "Drinks",
  "Snacks",
  "Frozen",
  "Tobacco",
  "Grocery & Pantry",
  "Dairy & Bakery",
  "Household & Health",
  "Other",
];

const client = new Anthropic();

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: RESPONSE_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const images = Array.isArray(payload.images) ? payload.images : [];
  if (images.length === 0) {
    return {
      statusCode: 400,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ error: "No images provided" }),
    };
  }
  if (images.length > 10) {
    return {
      statusCode: 400,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({ error: "Too many images (max 10 per scan)" }),
    };
  }

  const imageBlocks = images.map((base64) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: base64,
    },
  }));

  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              deliveryInfo: {
                type: "array",
                description: "Header/summary fields from the top of the FIRST page only (run ID, store number, store name, address, delivery date, cage count, crate counts, box counts, seal number, etc). Empty array if this batch of photos doesn't include that header section.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Field label as printed, e.g. 'Cage Count', 'Store Name'" },
                    value: { type: "string", description: "The value for that field" },
                  },
                  required: ["label", "value"],
                  additionalProperties: false,
                },
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      description: "Product name as printed on the invoice, cleaned up for readability",
                    },
                    quantity: {
                      type: "integer",
                      description: "Expected quantity/case count for this line item",
                    },
                    unit: {
                      type: "string",
                      description: "Unit if shown, e.g. 'case', 'box', 'ea' — empty string if not specified",
                    },
                    category: {
                      type: "string",
                      enum: CATEGORIES,
                    },
                  },
                  required: ["name", "quantity", "unit", "category"],
                  additionalProperties: false,
                },
              },
            },
            required: ["deliveryInfo", "items"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: `These are one or more photos of the same delivery invoice/packing slip for a convenience store (may span multiple photos of one long list).

First, check if any of these photos is the FIRST page of the invoice — it usually has a header/summary table above the line items (things like Run ID, Drop, Sequence, Store Number, Store Name, Address, Delivery Date, Cage Count, Milk Crates Count, Black Crates Count, Krispy Kreme/Daniels Donuts Box Count, Banana Box Count, Seal Number — exact fields vary by supplier). If present, extract every field from that header as a label/value pair in "deliveryInfo", in the order they appear. If none of these photos show that header section, return an empty array for "deliveryInfo" — don't guess or invent fields.

Then extract every product line item into a flat list: product name, expected quantity, unit if shown, and a category from the allowed set.

These invoices are dense tables — some pages have 20+ rows packed tightly together, sometimes with small or faint print, and category labels are sometimes only shown once for a whole group of rows rather than repeated on every row. Before answering, work through the table systematically from top to bottom, row by row, and count how many rows you found — it's easy to accidentally stop partway through a long table or skip a row that shares a category label with the one above it. Every single row in the table is a separate line item that must appear in your output, even ones near the bottom of the page or in a densely packed section.

Rules:
- Merge lines that are clearly the same product split across photos — don't duplicate.
- If a quantity isn't legible, use your best reading rather than guessing 1.
- Keep product names short and recognizable (as you'd see them on a shelf), not the full distributor SKU description.
- Pick the closest category even if it's a rough fit; use "Other" only when nothing fits.
- Do not omit a row because you're unsure about part of it — include it with your best-effort reading rather than dropping it.`,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      return {
        statusCode: 502,
        headers: RESPONSE_HEADERS,
        body: JSON.stringify({ error: "No structured output returned" }),
      };
    }

    const parsed = JSON.parse(textBlock.text);
    return {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({
        items: parsed.items || [],
        deliveryInfo: parsed.deliveryInfo || [],
      }),
    };
  } catch (err) {
    console.error("parse-invoice error:", err);
    return {
      statusCode: err.status || 500,
      headers: RESPONSE_HEADERS,
      body: JSON.stringify({
        error: "Failed to read invoice",
        detail: err.message || String(err),
      }),
    };
  }
};
