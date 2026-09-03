# Changelog

Entries go under **Unreleased** as work lands. `pnpm release <version>` moves them under a version heading
(docs/RELEASE.md).

## Unreleased

Proof of concept of the Fiscal Note Workbench for the Washington Department of Revenue.

- Bill ingest from the Legiscan dataset and lawfilesext XML; bill viewer with outline, version switcher and redline.
- Search over bills, sections, amendments, notes and templates (OpenSearch, or a Postgres fallback).
- Note editor: twelve templates, slots, self-summing estimate tables, citations into the bill, formulas, comments, autosave with version history and redline.
- Review workflow: ten states, itemised change requests, executive review chain, deadlines, inbox and email notifications, audit log.
- Publishing: the approved note beside the bill; export to HTML, PDF, DOCX and a placeholder FNS XML.
- Deployment: one EC2 box, ECR images, deploy through SSM after CI on `main`.
- Release process: `pnpm release`, version and commit in the footer and on `/api/v1/health`.
