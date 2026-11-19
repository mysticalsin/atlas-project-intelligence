# M-1 — Wiki export ZIP and gateway CSP middleware

## Context
`POST /api/wiki/export` returns `application/zip` bytes. The global `boundary` middleware decided HTML vs non-HTML CSP by reading `response.text` before headers were set.

## Decision
Classify responses from `response.content_type` only. Touch `response.text` for HTML bodies only, so binary ZIP exports are never UTF-8 decoded.

## Consequence
ZIP downloads get `default-src 'none'; frame-ancestors 'none'` and status 200. HTML pages keep hash-based CSP unchanged.

## Evidence
`tests/test_quality.py::test_wiki_export_http_roundtrip_returns_zip`