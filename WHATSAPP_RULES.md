# WhatsApp automation rules (William)

## Scope
- Trigger: any inbound WhatsApp message (DM or group).
- Only act when the inbound message contains **media** of type **image** or **pdf/document**.
- Process **everything** (do not ignore items). If unsure, classify as `UNKNOWN`.

## Classification
- **Factura**: a purchase invoice/receipt for products/services (someone bought products).
- **Transaccion**: a bank movement proof. Report the transaction amount and **force it positive** (sometimes screenshots show debits as negative even though it's income for William).

## Reply policy (critical)
- **Never reply** in the originating chat (DM or group).
- Only send notifications to William's number: **+573126027280**.

## Notification content
When media is classified as Factura or Transaccion, send William a message including:
- Category (FACTURA or TRANSACCION)
- Date/time received (local America/Bogota)
- Extracted value (COP) if found, otherwise say "valor no identificado"
- Running daily totals:
  - Total FACTURAS today
  - Total TRANSACCIONES today

## Persistence
- Maintain daily totals per day (America/Bogota) across restarts.
- Append each detected item to:
  - `data/facturas.csv`
  - `data/transacciones.csv`

Each row includes ISO date, source (dm/group), sender id (if available), category, value, currency, notes, and a media file reference.

## Safety
- Do not store or share unnecessary personal data.
- If classification is uncertain, mark as `UNKNOWN` and still notify William (but do not reply to source).
