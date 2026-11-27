alter table public.tiktok_connections
  add column refresh_token_ciphertext text,
  add column refresh_expires_at timestamptz,
  add column refresh_claim_until timestamptz;
