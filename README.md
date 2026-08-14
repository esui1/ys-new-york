# YS New York

A quiet-luxury accessories brand I founded, launching with a limited-edition monogrammed scarf woven in Switzerland.

This repository contains the complete e-commerce site — hand-coded with zero frontend dependencies.

## Features

- **Drag-to-compare slider** — interactive before/after view of the double-face cloth
- **Real-time edition tracker** — shows remaining pieces from the limited run of 100
- **Checkout with card validation** — Stripe integration with Apple Pay / Google Pay support
- **Fully responsive** — designed for desktop, tablet, and mobile
- **Accessible modals and forms** — keyboard navigation and screen reader support
- **CSS-only animations** — smooth transitions without JavaScript libraries

## Stack

### Frontend (`site/`)
- Vanilla HTML, CSS, and JavaScript
- No frameworks, no build step, no dependencies
- Single-page architecture with CSS Grid and Flexbox layout
- WebGL-style cloth rendering in pure Canvas 2D

### Backend (`server/`)
- Node.js with Express
- SQLite for the edition register (numbers 001–100)
- Stripe Checkout for payments
- Resend for transactional email
- Stateless JWT-style session tokens

## Project Structure

```
site/           Static frontend — deploy to any host
  index.html    The entire storefront
  legal/        Terms, privacy, shipping, imprint
server/         Node.js backend
  server.js     Edition register, accounts, orders, Stripe webhook
```

## Running Locally

```bash
# Frontend only (demo mode)
cd site && python -m http.server 8000

# Full stack
cd server && npm install && node server.js
```

Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` for live payments.

## Note

The legal pages (`/legal/*.html`) are templates with placeholder text. They require review by a lawyer before commercial use.

---

Designed and built by the founder.
