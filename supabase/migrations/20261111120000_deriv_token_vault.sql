-- Deriv OAuth credentials are encrypted by the Netlify server before storage.
-- The browser role must never read or write this table.
create table if not exists public.deriv_token_vault (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_token text not null,
  expires_at timestamptz not null,
  scope text not null default '',
  selected_account_id text,
  updated_at timestamptz not null default now()
);
alter table public.deriv_token_vault enable row level security;
revoke all on table public.deriv_token_vault from public, anon, authenticated;
grant all on table public.deriv_token_vault to service_role;
drop policy if exists "No client access to Deriv token vault" on public.deriv_token_vault;
create policy "No client access to Deriv token vault"
  on public.deriv_token_vault for all
  using (false) with check (false);
