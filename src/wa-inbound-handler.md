# WhatsApp inbound media handling (runtime behavior)

This is the *operational* behavior expected from the WhatsApp agent.

## On every inbound WhatsApp message (DM or Group)
1) If there is **no media** attached: do nothing.
2) If media is an **image** (jpg/png/webp/gif) or **PDF**:
   - Analyze and classify as:
     - `FACTURA` (purchase invoice/receipt; report TOTAL)
     - `TRANSACCION` (bank transaction proof; report amount; force positive)
     - `UNKNOWN` (can’t decide)
   - Extract a COP value if possible.
   - Persist to logs + daily totals.
   - **Never reply to the originating chat.**
   - **Only notify William** at `+573126027280` with:
     - Category
     - Value (or "valor no identificado")
     - Daily totals (facturas/transacciones) after this item.

## Persistence files
- `data/facturas.csv`
- `data/transacciones.csv`
- `data/no_clasificadas.csv`
- `data/daily-totals.json`

## Implementation notes
- The classification core exists at `src/whatsapp-media-classifier.js`.
- The ledger helper exists at `src/wa-ledger.js`.
