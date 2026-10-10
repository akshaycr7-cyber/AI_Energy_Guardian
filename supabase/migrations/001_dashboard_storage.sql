-- AI Energy Guardian durable dashboard storage for Supabase PostgreSQL.
-- Apply this migration in the Supabase SQL Editor before enabling credentials.

create extension if not exists pgcrypto;

create table if not exists public.sensor_readings (
    id uuid primary key default gen_random_uuid(),
    evaluated_at timestamptz not null,
    sensor_timestamp timestamptz not null,
    reading_date date,
    class_time text,
    lecture text,
    occupancy integer not null check (occupancy between 0 and 500),
    temperature_c double precision not null check (temperature_c between -30 and 70),
    humidity_pct double precision not null check (humidity_pct between 0 and 100),
    cloud_cover_pct double precision check (cloud_cover_pct between 0 and 100),
    precipitation_mm double precision check (precipitation_mm >= 0),
    weather_condition text,
    light_level double precision check (light_level >= 0),
    no_of_lights_on integer check (no_of_lights_on between 0 and 100),
    no_of_fans_on integer check (no_of_fans_on between 0 and 100),
    smart_board_on boolean not null default false,
    measured_power_w double precision check (measured_power_w >= 0),
    data_source text not null check (data_source in ('simulated', 'esp32', 'manual', 'imported')),
    reading_json jsonb not null,
    created_at timestamptz not null default now()
);

create table if not exists public.predictions (
    id uuid primary key default gen_random_uuid(),
    reading_id uuid not null unique references public.sensor_readings(id) on delete cascade,
    occupancy_prediction text not null,
    predicted_fan_count integer not null check (predicted_fan_count >= 0),
    predicted_light_count integer not null check (predicted_light_count >= 0),
    model_version text,
    prediction_json jsonb not null,
    created_at timestamptz not null default now()
);

create table if not exists public.ai_decisions (
    id uuid primary key default gen_random_uuid(),
    reading_id uuid not null unique references public.sensor_readings(id) on delete cascade,
    prediction_id uuid not null unique references public.predictions(id) on delete cascade,
    recommended_fan_count integer not null check (recommended_fan_count >= 0),
    recommended_light_count integer not null check (recommended_light_count >= 0),
    reason text not null,
    ai_mode text not null,
    hardware_control_enabled boolean not null default false check (hardware_control_enabled = false),
    sensor_data_status jsonb not null,
    power_status text not null,
    decision_json jsonb not null,
    created_at timestamptz not null default now()
);

create index if not exists sensor_readings_evaluated_at_desc_idx
    on public.sensor_readings (evaluated_at desc);
create index if not exists sensor_readings_data_source_idx
    on public.sensor_readings (data_source, evaluated_at desc);

alter table public.sensor_readings enable row level security;
alter table public.predictions enable row level security;
alter table public.ai_decisions enable row level security;

-- The API server uses the service_role only. Browser clients receive no key and
-- have no table policies, so they cannot query or insert these records directly.
revoke all on table public.sensor_readings, public.predictions, public.ai_decisions
    from public, anon, authenticated;

create or replace function public.record_evaluation(
    p_timestamp timestamptz,
    p_reading jsonb,
    p_prediction jsonb,
    p_decision jsonb,
    p_sensor_data_status jsonb,
    p_power_status text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_reading_id uuid;
    v_prediction_id uuid;
begin
    insert into public.sensor_readings (
        evaluated_at, sensor_timestamp, reading_date, class_time, lecture,
        occupancy, temperature_c, humidity_pct, cloud_cover_pct, precipitation_mm,
        weather_condition, light_level, no_of_lights_on, no_of_fans_on,
        smart_board_on, measured_power_w, data_source, reading_json
    ) values (
        p_timestamp, (p_reading ->> 'timestamp')::timestamptz,
        (p_reading ->> 'date')::date, p_reading ->> 'time', p_reading ->> 'lecture',
        (p_reading ->> 'occupancy')::integer, (p_reading ->> 'temperature_c')::double precision,
        (p_reading ->> 'humidity_pct')::double precision, (p_reading ->> 'cloud_cover_pct')::double precision,
        (p_reading ->> 'precipitation_mm')::double precision, p_reading ->> 'weather_condition',
        (p_reading ->> 'light_level')::double precision, (p_reading ->> 'no_of_lights_on')::integer,
        (p_reading ->> 'no_of_fans_on')::integer, coalesce((p_reading ->> 'smart_board_on')::boolean, false),
        (p_reading ->> 'measured_power_w')::double precision, p_reading ->> 'data_source', p_reading
    ) returning id into v_reading_id;

    insert into public.predictions (
        reading_id, occupancy_prediction, predicted_fan_count, predicted_light_count,
        model_version, prediction_json
    ) values (
        v_reading_id, p_prediction ->> 'occupancy_prediction',
        (p_prediction ->> 'predicted_fan_count')::integer,
        (p_prediction ->> 'predicted_light_count')::integer,
        p_prediction ->> 'model_version', p_prediction
    ) returning id into v_prediction_id;

    insert into public.ai_decisions (
        reading_id, prediction_id, recommended_fan_count, recommended_light_count,
        reason, ai_mode, hardware_control_enabled, sensor_data_status, power_status, decision_json
    ) values (
        v_reading_id, v_prediction_id, (p_decision ->> 'recommended_fan_count')::integer,
        (p_decision ->> 'recommended_light_count')::integer, p_decision ->> 'reason',
        p_decision ->> 'ai_mode', false, p_sensor_data_status, p_power_status, p_decision
    );
    return v_reading_id;
end;
$$;

create or replace function public.dashboard_history(p_limit integer default 30)
returns table(record jsonb)
language sql
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'id', r.id,
        'timestamp', r.evaluated_at,
        'reading', r.reading_json,
        'prediction', p.prediction_json,
        'decision', d.decision_json,
        'sensor_data_status', d.sensor_data_status,
        'power_status', d.power_status
    )
    from public.sensor_readings r
    join public.predictions p on p.reading_id = r.id
    join public.ai_decisions d on d.reading_id = r.id
    order by r.evaluated_at desc
    limit greatest(least(p_limit, 200), 1);
$$;

revoke all on function public.record_evaluation(timestamptz, jsonb, jsonb, jsonb, jsonb, text)
    from public, anon, authenticated;
revoke all on function public.dashboard_history(integer) from public, anon, authenticated;
grant execute on function public.record_evaluation(timestamptz, jsonb, jsonb, jsonb, jsonb, text)
    to service_role;
grant execute on function public.dashboard_history(integer) to service_role;
