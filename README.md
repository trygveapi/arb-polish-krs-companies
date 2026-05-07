# Polish KRS Company Registry API

REST wrapper around Poland's official KRS (Krajowy Rejestr Sądowy) National Court Register operated by the Ministry of Justice. Provides structured access to registered legal entities including company name, KRS number, NIP tax ID, REGON statistical number, legal form, registered address, and registration status. Suitable for KYB, supplier onboarding, and compliance workflows targeting Polish counterparties.

## Quick start

```bash
curl -H "Authorization: Bearer YOUR_KEY" https://polish-krs-companies.trygve-api.workers.dev/v1/companies
```

## Endpoints

- `GET /healthz` — liveness check (no auth)
- `GET /openapi.json` — machine-readable spec
- `GET /docs` — interactive Swagger UI
- `GET /v1/companies` — list with pagination
- `GET /v1/companies/:id` — single record

Full schema: see `/openapi.json`.

## Pricing

| Tier    | Requests / month | Price |
|---------|------------------|-------|
| Free    | 100              | $0    |
| Starter | 10,000           | $9    |
| Pro     | 100,000          | $29   |

Get a key: https://polish-krs-companies.trygve-api.workers.dev/docs

## Source data

This API is a clean wrapper of the public source at https://prs.ms.gov.pl/krs/openApi.
We refresh the cache on a `0 3 * * *` schedule.

## License

The wrapped API itself is MIT. Underlying data: see https://prs.ms.gov.pl/krs/openApi.
