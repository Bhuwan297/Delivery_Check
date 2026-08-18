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
      max_tokens: 4096,
      thinking: { type: "disabled" },
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
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
            required: ["items"],
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
              text: `These are one or more photos of the same delivery invoice/packing slip for a convenience store (may span multiple photos of one long list). Extract every line item into a flat list: product name, expected quantity, unit if shown, and a category from the allowed set.

Rules:
- Merge lines that are clearly the same product split across photos — don't duplicate.
- If a quantity isn't legible, use your best reading rather than guessing 1.
- Keep product names short and recognizable (as you'd see them on a shelf), not the full distributor SKU description.
- Pick the closest category even if it's a rough fit; use "Other" only when nothing fits.`,
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
      body: JSON.stringify({ items: parsed.items || [] }),
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
