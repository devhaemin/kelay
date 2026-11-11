-- Trigram similarity powers feedback dedupe (tickets_text_trgm_idx) and must exist before the schema migration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
