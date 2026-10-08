# DyPOS Enterprise Cloud & Edge 🚀
### Global Production ERP & POS Engine v1.37.0 — Final Smart Update

DyPOS is a production-grade, offline-first, enterprise ERP and POS system designed for high-availability environments. It combines the power of cloud serverless PostgreSQL (Neon) with an edge-ready architecture for seamless operation in retail, hospitality, and service industries.

---

## 🏗 Tech Stack

- **Frontend:** React 19, Vite 8, Tailwind CSS v4.
- **Backend:** Node.js (TypeScript), Express — plus a Cloudflare Worker (`worker/index.ts`) that serves the same `/api/db/*` contract at the edge.
- **Database:** Neon Serverless PostgreSQL (Global Schema).
- **AI Integration:** Google Gemini Pro (Semantic Search & Analytics).
- **Architecture:** Offline-First with Conflict Resolution & Audit Engine.

---

## 🗂 Screen licensing — single source of truth

Screens are gated in exactly one place, `src/config/industryProfiles.ts`:

- Each `IndustryProfile` declares a `tabs` list, using **the same screen ids** the renderer (`MainLayout`) uses (`work_order`, `batch_expiry`, `serial_imei`, …).
- `SCREEN_CAPABILITY` maps each screen id to the capability it requires.
- `capabilitiesForProfile()` **derives** a sector's capabilities from its `tabs`, so a screen can never be visible without the capability behind it.

Previously two independent vocabularies had drifted apart (`tabs` used plurals like
`work_orders` while `navItems` used `work_order`), and the `capabilities` lists were
hand-maintained and incomplete — which silently hid most screens from the sidebar.

---

## 🧾 Sales are persisted, not simulated

`POST /api/db/invoices` writes an invoice, its lines and the stock movements
inside **one transaction**. Checkout used to mutate React state only, so a sale
vanished on refresh.

Two rules the route depends on:

1. **Never `DROP TABLE` on boot.** The schema bootstrap once dropped fourteen
   tables with `CASCADE` on every start, destroying all sales, stock movements
   and journal entries. Schema changes now go through additive migrations only.
2. **Never update `products.stock` directly.** A trigger
   (`trigger_update_stock`) already applies every `stock_movements` row. A manual
   `UPDATE` plus the movement cancels out, and stock silently never moves. The
   movement row is the single source of truth.

An over-sale is refused with `409` rather than driving stock negative, and the
response carries `stockAfter` so the till refreshes from the committed value.

### Applying migrations
```bash
npm run migrate          # apply everything pending
npm run migrate:status   # list applied / pending
```

## 🚦 Enabling every work screen

`dypos.tenant_capabilities` is seeded at schema-init time. To re-provision or narrow
the grant for a tenant:

```sql
INSERT INTO dypos.tenant_capabilities (tenant_id, capability_id, is_enabled)
SELECT 'royal-global-hq', c.id, TRUE FROM dypos.capabilities c
ON CONFLICT (tenant_id, capability_id) DO UPDATE SET is_enabled = TRUE;
```

If a tenant has **no** grant rows, the client falls back to the sector profile's
defaults rather than treating the empty set as a licence denial.

---

## 📂 Project Structure

- `/src`: Frontend application (React components, hooks, state).
- `/server`: Backend API and Database initialization.
- `/server/neonDb.ts`: Core database engine and schema manager.
- `/server/*.sql`: Professional SQL migration packs (v24 - v130).
- `/docs`: Detailed system documentation.

---

## 🚀 Getting Started

### 1. Environment Setup
Create a `.env` file in the root directory:
```env
DATABASE_URL=your_neon_postgresql_url
GEMINI_API_KEY=your_google_ai_studio_api_key
```

### 2. Installation
```bash
npm install
```

### 3. Database Initialization
The system automatically initializes the schema on the first run. You can manually trigger it via:
```bash
# Via API (POST)
curl -X POST/api/db/init
```

### 4. Development
```bash
npm run dev
```

---

## 🛡 Security & Audit
- **RLS:** Row Level Security implemented at the database level for tenant isolation.
- **Audit Engine:** All mutations are logged in `dypos.audit_log` with before/after state.
- **Device Management:** Hardware-bound authentication for POS terminals.

---

## 📄 License
Property of **Smart Ports Software (شركة المنافذ الذكية للبرمجيات)**.
Confidential & Proprietary.
