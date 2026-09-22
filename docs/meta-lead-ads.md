# Meta Lead Ads → contacts

Facebook/Instagram Lead Ads form submissions can land here automatically
as contacts (tagged **"Meta Ads"**), the same way WhatsApp messages
create contacts today. This is optional — nothing changes until the
env vars below are set.

**You do not need to touch the Meta App the WhatsApp number is
registered under.** A "Meta App" is just an administrative object Meta
requires to grant API access — it has no relation to your CRM, your
bot, or its name. The simplest path is a brand new app made only for
this.

## How it works

1. Someone submits one of your Lead Ads forms on Facebook/Instagram.
2. Meta POSTs a `leadgen` event to `/api/meta/leadgen/webhook` — the
   event only carries a `leadgen_id`, not the actual answers.
3. The webhook fetches the full answers from the Graph API using a
   Page access token, matches phone/email/name fields by common
   naming patterns (`phone`, `telefono`, `email`, `correo`,
   `full_name`, `nombre`, ...), and creates or matches a contact via
   the same dedupe logic the WhatsApp webhook and public API use.
4. The contact gets tagged **"Meta Ads"** (auto-created the first
   time), and every teammate on the account gets a "New lead from
   Meta Ads" notification linking straight to that contact.

## One-time setup on Meta's side

### 1. Create a Meta App

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
   → **Create App**.
2. Pick use case **"Other"** → app type **"Business"**. Give it any
   name (e.g. "BSign Leads") — it's never shown to customers.
3. When asked which Business Portfolio it belongs to, pick the one
   your Facebook Page (the one running the ads) lives under.

### 2. Add the Webhooks product

1. In your new app's left sidebar → **Add Product** → find
   **Webhooks** → **Set up**.
2. Under **Webhooks**, click the object-type dropdown and choose
   **Page**.
3. Click **Subscribe to this object** and fill in:
   - **Callback URL**: `https://<your-crm-domain>/api/meta/leadgen/webhook`
   - **Verify Token**: any string you choose — put this exact string
     in `META_LEADGEN_VERIFY_TOKEN` (see below) **and deploy it**
     *before* clicking "Verify and Save", since Meta calls your
     webhook live to check it.
4. Once verified, tick the **`leadgen`** field in the list that
   appears.

### 3. Connect your Page and get a Page access token

1. Still in the Webhooks product, scroll to **"Page"** subscriptions
   at the bottom → find your Page → click **Subscribe**. If your Page
   doesn't show up, add it first via **App Settings → Basic →
   Business Portfolio**, or via **Business Settings**
   (business.facebook.com) → Accounts → Pages → make sure this app is
   connected there.
2. Get a Page access token with `leads_retrieval`:
   [Graph API Explorer](https://developers.facebook.com/tools/explorer)
   → top-right, pick **your app** and **your Page** (not your personal
   user) → under Permissions add `leads_retrieval` (and
   `pages_show_list` if prompted) → **Generate Access Token**.
   → `META_LEADGEN_PAGE_ACCESS_TOKEN`.
   - This token from the Explorer is short-lived. For anything beyond
     testing, exchange it for a long-lived one (~60 days) via Meta's
     `oauth/access_token` endpoint, or come back to this when you get
     there.

### 4. Get your App Secret

**App Settings → Basic → App Secret** (click "Show") →
`META_LEADGEN_APP_SECRET`.

### 5. Get your wacrm account id

This CRM is single-tenant per deployment — there's no per-Page account
table like WhatsApp's. Create any API key (Settings → API keys) and
call `GET /api/v1/me` with it (see `docs/public-api.md`) — the
response's `account.id` is `META_LEADGEN_ACCOUNT_ID`.

## Env vars

See `.env.local.example` for the full block:

```
META_LEADGEN_APP_SECRET=...
META_LEADGEN_VERIFY_TOKEN=...
META_LEADGEN_PAGE_ACCESS_TOKEN=...
META_LEADGEN_ACCOUNT_ID=...
```

`META_LEADGEN_APP_SECRET` is optional if — instead of a new app — you
deliberately reuse the same Meta App that already backs
`META_APP_SECRET` (WhatsApp): leave it unset and the webhook falls
back to that one.

## Testing

Facebook Page → **Publishing Tools → Lead Ads Testing Tool**, or fill
out one of your real forms yourself. Check wacrm's **Contacts** for a
new row tagged "Meta Ads" and **Notifications** for the alert.

## Limitations

- **Single Page.** One `META_LEADGEN_PAGE_ACCESS_TOKEN` /
  `META_LEADGEN_ACCOUNT_ID` pair per deployment. Multiple Pages
  funneling into different accounts would need a page_id → account_id
  lookup table instead of these two env vars — not built, since this
  CRM currently only serves one business.
- **Field matching is heuristic.** A lead form whose phone question is
  named something unusual (not matching `phone`/`telefono`/`celular`/
  `whatsapp`) is skipped with a `console.warn` logging the raw
  `field_data`, rather than guessed at. Rename the field in the Lead
  Ads form, or extend the matcher in `src/lib/meta/leadgen.ts`.
- **Page access tokens expire.** A long-lived Page token (via a
  long-lived User token) lasts ~60 days unless your app completes App
  Review for the relevant permissions; budget for rotating it.
