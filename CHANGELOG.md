# Hobby Corner Lightspeed — Development Changelog

## 2026-11-10 — Vendor response-size precheck (development)

- Corrected the numeric `Content-Length` validation in the shared Lightspeed transport. Existing streamed and fallback body-size limits remain enforced.
- Added tests proving declared oversized responses fail **before body consumption** and dishonest declared lengths still fail against actual bytes.
- No live Lightspeed API requests, production credentials, database changes, or deployments. Pending review via a development PR.
