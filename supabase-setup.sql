-- =========================================================================
-- «Не Парься» — настройка базы Supabase
-- Скопируйте ВЕСЬ этот файл в Supabase → SQL Editor → New query → Run.
-- Запускать можно повторно: ничего не сломается и данные не удалятся.
-- =========================================================================

-- ---------- Отзывы ----------
create table if not exists public.reviews (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  university  text check (university is null or char_length(university) <= 80),
  work        text check (work is null or char_length(work) <= 60),
  message     text not null check (char_length(btrim(message)) between 10 and 1000),
  rating      smallint not null check (rating between 1 and 5),
  approved    boolean not null default true
);

alter table public.reviews enable row level security;

-- Посетители видят только одобренные отзывы
drop policy if exists "reviews: read approved" on public.reviews;
create policy "reviews: read approved" on public.reviews
  for select to anon, authenticated
  using (approved);

-- Отзывы оставляют только клиенты с выполненным заказом — через бота. На сайт отзыв
-- выкладывает бот, когда админ нажмёт «Опубликовать», с подписью, какая работа была сделана.
-- Посетители сайта отзывы только читают.
alter table public.reviews add column if not exists order_code text unique;
drop policy if exists "reviews: insert" on public.reviews;
revoke insert on public.reviews from anon, authenticated;

grant usage on schema public to anon, authenticated;
grant select on public.reviews to anon, authenticated;

-- Админы из panel_admins видят все отзывы (и скрытые), могут скрыть или удалить отзыв
-- в админ-панели сайта → вкладка «⭐ Отзывы». (panel_admins и is_panel_admin создаются ниже.)

-- ---------- Счётчик посетителей ----------
create table if not exists public.site_stats (
  id      int primary key default 1 check (id = 1),
  visits  bigint not null default 0
);
insert into public.site_stats (id) values (1) on conflict (id) do nothing;

-- Прямого доступа к таблице у посетителей нет — только через функции ниже
alter table public.site_stats enable row level security;
revoke all on public.site_stats from anon, authenticated;

-- Текущие цифры для блока счётчиков
create or replace function public.get_stats()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'visitors',     (select visits from site_stats where id = 1),
    'happyClients', (select count(*) from reviews where approved and rating >= 4)
  );
$$;

-- +1 посетитель (сайт вызывает один раз на браузер) и сразу новые цифры
create or replace function public.register_visit()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  update site_stats set visits = visits + 1 where id = 1;
  return get_stats();
end;
$$;

grant execute on function public.get_stats() to anon, authenticated;
grant execute on function public.register_visit() to anon, authenticated;


-- ---------- Передача заказа с сайта в Telegram-бота ----------
-- Сайт кладёт заявку под случайным кодом, бот забирает её по ссылке
-- t.me/<бот>?start=order_<код> своим секретным ключом и удаляет.
-- Посетители могут только добавлять заявки — прочитать чужие нельзя.
create table if not exists public.bot_handoff (
  code        text primary key check (code ~ '^[A-Za-z0-9]{8,32}$'),
  payload     jsonb not null check (octet_length(payload::text) <= 20000),
  created_at  timestamptz not null default now()
);
alter table public.bot_handoff enable row level security;
drop policy if exists "bot_handoff: insert" on public.bot_handoff;
create policy "bot_handoff: insert" on public.bot_handoff
  for insert to anon, authenticated
  with check (true);
grant insert on public.bot_handoff to anon, authenticated;
grant select, delete on public.bot_handoff to service_role;


-- =========================================================================
-- Кабинет клиента и админ-панель на сайте
-- Данные сюда выгружает бот (своим секретным ключом). Посетители сайта
-- напрямую таблицы не видят: админы — после входа по паролю, клиент — только
-- свои заказы по личному ключу из бота.
-- =========================================================================

-- Кто может войти в админ-панель: e-mail админов (добавьте свои, см. README)
create table if not exists public.panel_admins (email text primary key);
alter table public.panel_admins enable row level security;

create or replace function public.is_panel_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from panel_admins
                 where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
grant execute on function public.is_panel_admin() to anon, authenticated;

drop policy if exists "reviews: admins read all" on public.reviews;
create policy "reviews: admins read all" on public.reviews
  for select to authenticated using (public.is_panel_admin());
drop policy if exists "reviews: admins update" on public.reviews;
create policy "reviews: admins update" on public.reviews
  for update to authenticated using (public.is_panel_admin()) with check (public.is_panel_admin());
drop policy if exists "reviews: admins delete" on public.reviews;
create policy "reviews: admins delete" on public.reviews
  for delete to authenticated using (public.is_panel_admin());
grant update, delete on public.reviews to authenticated;

create table if not exists public.cloud_orders (
  id             bigint primary key,
  code           text not null unique,
  tg_user_id     bigint not null,
  client_name    text,
  client_username text,
  client_token   text,
  type           text,
  type_name      text,
  status         text,
  price          integer,
  prepay         integer,
  paid           integer not null default 0,
  deadline       text,
  deadline_text  text,
  source         text,
  admin_name     text,
  reject_reason  text,
  lines          jsonb,
  created_at     timestamptz,
  updated_at     timestamptz
);
create index if not exists cloud_orders_token on public.cloud_orders (client_token);
alter table public.cloud_orders enable row level security;
drop policy if exists "cloud_orders: admins read" on public.cloud_orders;
create policy "cloud_orders: admins read" on public.cloud_orders
  for select to authenticated using (public.is_panel_admin());

create table if not exists public.cloud_payments (
  id            bigint primary key,
  order_id      bigint not null,
  kind          text,
  amount        integer,
  status        text,
  confirmed_by  text,
  receipt_path  text,
  created_at    timestamptz,
  confirmed_at  timestamptz
);
alter table public.cloud_payments enable row level security;
drop policy if exists "cloud_payments: admins read" on public.cloud_payments;
create policy "cloud_payments: admins read" on public.cloud_payments
  for select to authenticated using (public.is_panel_admin());

create table if not exists public.cloud_files (
  id          text primary key,
  order_id    bigint not null,
  kind        text not null check (kind in ('client', 'result')),
  name        text,
  bucket      text not null,
  path        text not null,
  size        bigint,
  source      text not null default 'bot',
  delivered   boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table public.cloud_files enable row level security;
-- Файлы, загруженные вместе с «отправить всё сразу», бот отправляет одним сообщением
alter table public.cloud_files add column if not exists batch text;
drop policy if exists "cloud_files: admins read" on public.cloud_files;
create policy "cloud_files: admins read" on public.cloud_files
  for select to authenticated using (public.is_panel_admin());
drop policy if exists "cloud_files: admins add results" on public.cloud_files;
create policy "cloud_files: admins add results" on public.cloud_files
  for insert to authenticated
  with check (public.is_panel_admin() and kind = 'result' and source = 'site'
              and bucket = 'results' and delivered = false);

-- Действия админов на сайте (цена, статус, сообщение) — бот выполняет их у себя
create table if not exists public.cloud_actions (
  id          bigint generated always as identity primary key,
  order_id    bigint not null,
  action      text not null,
  payload     jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 5000),
  created_by  text default (auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  state       text not null default 'pending',
  result      text
);
alter table public.cloud_actions enable row level security;
-- bundle — «отправить всё сразу» (цена, срок, статус, сообщение и файлы одной кнопкой)
alter table public.cloud_actions drop constraint if exists cloud_actions_action_check;
alter table public.cloud_actions add constraint cloud_actions_action_check
  check (action in ('price', 'status', 'message', 'bundle', 'delete'));
drop policy if exists "cloud_actions: admins read" on public.cloud_actions;
create policy "cloud_actions: admins read" on public.cloud_actions
  for select to authenticated using (public.is_panel_admin());
drop policy if exists "cloud_actions: admins add" on public.cloud_actions;
create policy "cloud_actions: admins add" on public.cloud_actions
  for insert to authenticated with check (public.is_panel_admin() and state = 'pending');

-- Заказы, добавленные вручную в админ-панели (клиент и сумма) — входят в статистику
create table if not exists public.manual_orders (
  id           bigint generated always as identity primary key,
  client_name  text not null check (char_length(btrim(client_name)) between 1 and 80),
  amount       integer not null check (amount > 0 and amount < 10000000),
  created_by   text default (auth.jwt() ->> 'email'),
  created_at   timestamptz not null default now()
);
alter table public.manual_orders enable row level security;
drop policy if exists "manual_orders: admins" on public.manual_orders;
create policy "manual_orders: admins" on public.manual_orders
  for all to authenticated using (public.is_panel_admin()) with check (public.is_panel_admin());
grant select, insert, delete on public.manual_orders to authenticated;
grant all on public.manual_orders to service_role;

-- Заказы, отправленные с сайта, пока бот выключен: бот проверит подпись Telegram и примет их
create table if not exists public.incoming_orders (
  id         bigint generated always as identity primary key,
  init_data  text not null check (char_length(init_data) <= 8000),
  payload    jsonb not null check (octet_length(payload::text) <= 20000),
  created_at timestamptz not null default now(),
  state      text not null default 'pending',
  result     text
);
alter table public.incoming_orders enable row level security;
drop policy if exists "incoming_orders: insert" on public.incoming_orders;
create policy "incoming_orders: insert" on public.incoming_orders
  for insert to anon, authenticated with check (state = 'pending');

create table if not exists public.site_settings (key text primary key, value text);
alter table public.site_settings enable row level security;

grant select on public.cloud_orders, public.cloud_payments, public.cloud_files, public.cloud_actions to authenticated;
grant insert on public.cloud_files, public.cloud_actions to authenticated;
grant insert on public.incoming_orders to anon, authenticated;
grant all on public.cloud_orders, public.cloud_payments, public.cloud_files, public.cloud_actions,
             public.incoming_orders, public.site_settings, public.panel_admins to service_role;

-- Кабинет клиента: только его заказы по личному ключу (ключ знает только он — из бота)
create or replace function public.client_cabinet(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select case when char_length(coalesce(p_token, '')) < 24 then null else (
    select json_build_object(
      'name', (select client_name from cloud_orders where client_token = p_token order by id desc limit 1),
      'payment_details', (select value from site_settings where key = 'payment_details'),
      'payment_extra', (select value from site_settings where key = 'payment_extra'),
      'orders', coalesce((
        select json_agg(json_build_object(
          'code', o.code, 'type_name', o.type_name, 'status', o.status, 'price', o.price,
          'prepay', o.prepay, 'paid', o.paid, 'deadline', o.deadline, 'deadline_text', o.deadline_text,
          'reject_reason', o.reject_reason, 'lines', o.lines, 'created_at', o.created_at,
          'files', coalesce((select json_agg(json_build_object('name', f.name, 'path', f.path) order by f.created_at)
                             from cloud_files f
                             where f.order_id = o.id and f.kind = 'result' and f.bucket = 'results'), '[]'::json)
        ) order by o.id desc)
        from cloud_orders o where o.client_token = p_token), '[]'::json)
    ))
  end;
$$;
grant execute on function public.client_cabinet(text) to anon, authenticated;

-- Хранилище файлов:
--   results — готовые работы (публичная папка, у каждого файла длинный случайный адрес);
--   private — чеки и файлы клиентов (видят только админы после входа).
insert into storage.buckets (id, name, public) values ('results', 'results', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('private', 'private', false) on conflict (id) do nothing;
drop policy if exists "results: admins upload" on storage.objects;
create policy "results: admins upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'results' and public.is_panel_admin());
drop policy if exists "private: admins read" on storage.objects;
create policy "private: admins read" on storage.objects
  for select to authenticated using (bucket_id = 'private' and public.is_panel_admin());


-- =========================================================================
-- Telegram-бот в облаке (Supabase Edge Function «bot»)
-- Все данные бота живут здесь. Посетители сайта к этим таблицам доступа
-- не имеют: с ними работает только сама функция бота.
-- =========================================================================
-- Расширения для расписания (pg_cron) и «пинка» бота с сайта (pg_net). Если их нельзя
-- включить здесь, включите вручную: Database → Extensions → pg_cron и pg_net.
do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then raise notice 'pg_net: %', sqlerrm;
end $$;
do $$ begin
  create extension if not exists pg_cron with schema pg_catalog;
  grant usage on schema cron to postgres;
exception when others then raise notice 'pg_cron: %', sqlerrm;
end $$;

create table if not exists public.bot_settings (key text primary key, value text);

create table if not exists public.bot_users (
  id           bigint primary key,
  first_name   text,
  username     text,
  created_at   timestamptz not null default now(),
  last_seen    timestamptz,
  source       text,
  blocked      boolean not null default false,
  bot_blocked  boolean not null default false,
  site_token   text unique
);

create table if not exists public.bot_orders (
  id                 bigint generated by default as identity primary key,
  code               text not null unique,
  user_id            bigint not null,
  data               jsonb not null,
  source             text not null,
  status             text not null default 'new',
  price              integer,
  prepay             integer,
  paid               integer not null default 0,
  deadline_text      text,
  admin_id           bigint,
  reject_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  status_changed_at  timestamptz not null default now(),
  done_at            timestamptz,
  remind_sent        boolean not null default false,
  review_requested   boolean not null default false,
  version            integer not null default 1,   -- растёт при каждом изменении заказа
  synced_version     integer not null default 0    -- какая версия уже показана на сайте
);
create index if not exists bot_orders_user on public.bot_orders (user_id);
create index if not exists bot_orders_status on public.bot_orders (status);
create index if not exists bot_orders_sync on public.bot_orders (id) where synced_version < version;

create table if not exists public.bot_files (
  id          bigint generated by default as identity primary key,
  order_id    bigint not null,
  kind        text not null,              -- client: от клиента, result: готовая работа
  file_id     text not null,              -- file_id в Telegram или ссылка на файл в облаке
  file_type   text not null,              -- document / photo
  file_name   text,
  created_at  timestamptz not null default now(),
  cloud_path  text,
  cloud_id    text
);
create index if not exists bot_files_order on public.bot_files (order_id);

create table if not exists public.bot_payments (
  id            bigint generated by default as identity primary key,
  order_id      bigint not null,
  kind          text not null,            -- prepay / final
  amount        integer not null,
  file_id       text,
  file_type     text,
  status        text not null default 'pending',   -- pending / confirmed / rejected
  confirmed_by  bigint,
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  cloud_path    text
);

-- Какое сообщение в чате админа относится к какому клиенту/заказу (для ответов реплаем)
create table if not exists public.bot_messages_map (
  chat_id     bigint not null,
  message_id  bigint not null,
  user_id     bigint not null,
  order_id    bigint,
  created_at  timestamptz not null default now(),
  primary key (chat_id, message_id)
);
-- Карточки у админов, которые нужно обновлять (заказ, чек, отзыв)
create table if not exists public.bot_cards (
  chat_id     bigint not null,
  message_id  bigint not null,
  kind        text not null,
  ref_id      bigint not null,
  primary key (chat_id, message_id)
);
create index if not exists bot_cards_ref on public.bot_cards (kind, ref_id);
-- Сообщения текущего «экрана» в чате клиента: удаляются при переходе на следующий
create table if not exists public.bot_screens (chat_id bigint primary key, ids jsonb not null default '[]');
create table if not exists public.bot_reviews (
  id            bigint generated by default as identity primary key,
  order_id      bigint not null unique,
  user_id       bigint not null,
  rating        integer not null,
  text          text,
  created_at    timestamptz not null default now(),
  published     boolean not null default false,
  published_by  bigint
);
alter table public.bot_reviews add column if not exists on_site boolean not null default false; -- уже выложен на сайт

-- Шаг диалога каждого пользователя (оформление заказа, ввод цены и т. п.)
create table if not exists public.bot_states (
  user_id     bigint primary key,
  state       text,
  data        jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);
-- Служебное: очередь одного пользователя, повторы от Telegram, рассылки
create table if not exists public.bot_locks (chat_id bigint primary key, until timestamptz not null);
create table if not exists public.bot_updates (update_id bigint primary key, created_at timestamptz not null default now());
create table if not exists public.bot_broadcasts (
  id          bigint generated by default as identity primary key,
  owner_id    bigint not null,
  from_chat   bigint not null,
  message_id  bigint not null,
  last_user   bigint not null default 0,
  ok          integer not null default 0,
  blocked     integer not null default 0,
  failed      integer not null default 0,
  state       text not null default 'running',
  created_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['bot_settings','bot_users','bot_orders','bot_files','bot_payments','bot_messages_map',
                           'bot_cards','bot_screens','bot_reviews','bot_states','bot_locks','bot_updates','bot_broadcasts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Примеры работ, шаблоны отзывов и FAQ для бота. Правьте прямо здесь:
-- Table Editor → bot_settings → строка content (это JSON).
insert into public.bot_settings (key, value) values ('content', $content${
  "_help": "Контент бота: примеры работ, шаблоны отзывов и FAQ. Правьте тексты прямо здесь (Supabase → Table Editor → bot_settings → строка content) — бот подхватит сразу. placeholder: true показывает пометку «Пример — замените своими»: у настоящих записей уберите эту строку. photo — ссылка на картинку (https://...); можно не указывать. Следите за кавычками и запятыми: если JSON испортится, бот покажет встроенные примеры.",
  "examples": [
    {
      "type": "Курсовая работа",
      "subject": "Предмет",
      "description": "Короткое описание работы — замените своим.",
      "placeholder": true
    },
    {
      "type": "Презентация",
      "subject": "Предмет",
      "description": "Короткое описание работы — замените своим.",
      "placeholder": true
    },
    {
      "type": "Чертежи",
      "subject": "Предмет",
      "description": "Короткое описание работы — замените своим.",
      "placeholder": true
    }
  ],
  "reviews": [
    {
      "name": "Имя клиента",
      "university": "ВУЗ, курс",
      "work": "Тип работы",
      "text": "Текст отзыва — замените реальным.",
      "rating": 5,
      "placeholder": true
    },
    {
      "name": "Имя клиента",
      "university": "ВУЗ, курс",
      "work": "Тип работы",
      "text": "Текст отзыва — замените реальным.",
      "rating": 5,
      "placeholder": true
    }
  ],
  "faq": [
    {
      "q": "Как формируется цена?",
      "a": "Цена индивидуальная: зависит от типа и объёма работы, срока, сложности темы и требований к оформлению и оригинальности. Оформите заказ — исполнитель посмотрит детали и назовёт точную стоимость. Оценка бесплатная и ни к чему не обязывает."
    },
    {
      "q": "Как оплатить?",
      "a": "После того как вы согласитесь с ценой, бот пришлёт реквизиты. Переведите сумму, укажите номер заказа в комментарии и пришлите чек сюда же — оплату подтвердят, и работа начнётся."
    },
    {
      "q": "Какие сроки?",
      "a": "Зависит от объёма: небольшие работы можно сделать за день-два, курсовые и дипломы — дольше. Если сроки горят — отметьте «срочное выполнение», и исполнитель скажет, успеем ли."
    },
    {
      "q": "Что если преподаватель попросит исправить?",
      "a": "Доработки по замечаниям преподавателя в рамках исходного задания — бесплатно. Просто пришлите замечания в этот чат."
    },
    {
      "q": "Это конфиденциально?",
      "a": "Да. Ваши данные, файлы и работы не передаются третьим лицам и нигде не публикуются."
    },
    {
      "q": "Как передать методичку и файлы?",
      "a": "При оформлении заказа в боте есть шаг «Файлы». Если заказ оформлен на сайте — просто пришлите файлы в этот чат, они прикрепятся к заказу."
    },
    {
      "q": "Как узнать статус заказа?",
      "a": "Нажмите «📦 Мои заказы» — там номер, срок, статус и цена каждого заказа. О каждой смене статуса бот пишет сам."
    }
  ]
}$content$)
on conflict (key) do nothing;

-- Сайт и админ-панель будят бота сразу, как только появляется новый заказ,
-- действие админа или загруженная работа (адрес бот записывает сам при настройке).
create or replace function public.np_bot_kick() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare u text;
begin
  select value into u from public.bot_settings where key = 'kick_url';
  if coalesce(u, '') <> '' then
    begin
      perform net.http_post(url := u, body := '{}'::jsonb);
    exception when others then null;  -- бот всё равно заберёт это при ежеминутной проверке
    end;
  end if;
  return null;
end $$;
drop trigger if exists np_kick_incoming on public.incoming_orders;
create trigger np_kick_incoming after insert on public.incoming_orders
  for each row execute function public.np_bot_kick();
drop trigger if exists np_kick_actions on public.cloud_actions;
create trigger np_kick_actions after insert on public.cloud_actions
  for each row execute function public.np_bot_kick();
drop trigger if exists np_kick_files on public.cloud_files;
create trigger np_kick_files after insert on public.cloud_files
  for each row when (new.source = 'site') execute function public.np_bot_kick();

