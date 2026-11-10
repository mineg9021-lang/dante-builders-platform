create table if not exists public.dante_profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create table if not exists public.dante_bot_configurations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    bot_key text not null,
    configuration jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    unique(user_id, bot_key)
);
create table if not exists public.dante_bot_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    bot_key text not null,
    account_mode text not null check (account_mode in ('analysis','demo','live')),
    status text not null,
    configuration jsonb not null default '{}'::jsonb,
    started_at timestamptz not null default now(),
    ended_at timestamptz
);
create table if not exists public.dante_trade_events (
    id bigint generated always as identity primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    bot_key text not null,
    deriv_account_id text,
    contract_id bigint,
    event_type text not null,
    event_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);
create table if not exists public.dante_audit_events (
    id bigint generated always as identity primary key,
    user_id uuid references auth.users(id) on delete set null,
    action text not null,
    event_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);
alter table public.dante_profiles enable row level security;
alter table public.dante_bot_configurations enable row level security;
alter table public.dante_bot_sessions enable row level security;
alter table public.dante_trade_events enable row level security;
alter table public.dante_audit_events enable row level security;

create policy "Users read own profile" on public.dante_profiles for select using (auth.uid() = id);
create policy "Users update own profile" on public.dante_profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "Users manage own bot configurations" on public.dante_bot_configurations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own bot sessions" on public.dante_bot_sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users read and append own trade events" on public.dante_trade_events for select using (auth.uid() = user_id);
create policy "Users append own trade events" on public.dante_trade_events for insert with check (auth.uid() = user_id);
create policy "Users read own audit events" on public.dante_audit_events for select using (auth.uid() = user_id);

create or replace function public.dante_create_profile()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
    insert into public.dante_profiles(id, email) values (new.id, new.email)
    on conflict (id) do update set email = excluded.email, updated_at = now();
    return new;
end;
$$;
drop trigger if exists dante_auth_user_created on auth.users;
create trigger dante_auth_user_created after insert or update of email on auth.users
for each row execute procedure public.dante_create_profile();
