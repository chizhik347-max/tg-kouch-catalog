# BACKEND-PLAN.md — Backend для Telegram Mini App психолога

> Один специалист, три услуги, реальное расписание, оплата через Telegram.  
> Документ описывает только то, что нужно **этому** приложению.

---

## 1. Что сейчас работает на клиенте и что нужно перенести

| Что сейчас | Где в коде | Проблема | Что делает backend |
|---|---|---|---|
| Занятость слотов — детерминированная формула `isSlotBooked()` | `data.js:192` | Не отражает реальные записи | Таблица `bookings` + `blocked_slots` |
| Записи в `localStorage` | `app.js:668` | Пропадают при перезагрузке, не видны Елене | Таблица `bookings` в БД |
| Оплата — setTimeout 1800мс | `app.js:638` | Деньги не списываются | Telegram Payments API + YooKassa |
| Бот-сообщения — не реализованы | `brief.md:463` | Клиент не получает подтверждение | Bot webhook → sendMessage |
| Идентификация пользователя — `initDataUnsafe` | `app.js:36` | Не верифицируется на сервере | HMAC-SHA256 проверка initData |

---

## 2. База данных

### Таблица `bookings`

Основная таблица — одна запись = одна сессия.

```sql
CREATE TABLE bookings (
  id                        SERIAL PRIMARY KEY,
  tg_user_id                BIGINT NOT NULL,           -- из initDataUnsafe.user.id
  client_name               VARCHAR(100) NOT NULL,     -- из поля confirm-name
  client_request            TEXT,                      -- из confirm-request (необязательно)
  service_id                VARCHAR(20) NOT NULL,      -- 'trial' | 'individual' | 'package'
  date                      DATE NOT NULL,             -- 'YYYY-MM-DD'
  time                      VARCHAR(5) NOT NULL,       -- '10:00' | '11:00' | ... | '20:00'
  status                    VARCHAR(20) NOT NULL DEFAULT 'upcoming',
                                                       -- 'upcoming' | 'past' | 'cancelled'
  payment_status            VARCHAR(20) NOT NULL DEFAULT 'free',
                                                       -- 'free' | 'pending' | 'paid' | 'refunded'
  tg_payment_charge_id      VARCHAR(100),              -- из successful_payment Telegram
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, time, status)                          -- один слот — одна активная запись
);

CREATE INDEX ON bookings (tg_user_id);
CREATE INDEX ON bookings (date, status);
```

**Значения `service_id`** берутся из `DATA.services[].id` в `data.js`: `trial`, `individual`, `package`.

**Значения `time`** берутся из `DATA.timeSlots` в `data.js`: `10:00`, `11:00`, `13:00`, `14:00`, `18:00`, `19:00`, `20:00`.

**Ограничение UNIQUE** на `(date, time, status='upcoming')` реализуется через partial unique index:
```sql
CREATE UNIQUE INDEX bookings_slot_unique
  ON bookings (date, time)
  WHERE status = 'upcoming';
```

---

### Таблица `blocked_slots`

Елена блокирует конкретные слоты вручную — отпуск, болезнь, личное.

```sql
CREATE TABLE blocked_slots (
  id         SERIAL PRIMARY KEY,
  date       DATE NOT NULL,
  time       VARCHAR(5),          -- NULL = весь день заблокирован
  reason     VARCHAR(200),        -- для себя, клиенту не показывается
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, time)
);
```

---

### Таблица `schedule_settings`

Одна строка — настройки расписания. Сейчас захардкожены в `data.js:187–189`, но нужны в БД чтобы Елена могла менять их без деплоя.

```sql
CREATE TABLE schedule_settings (
  id                  INTEGER PRIMARY KEY DEFAULT 1,  -- всегда одна строка
  available_weekdays  INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
                                                      -- 0=Вс, 1=Пн … 6=Сб
  time_slots          VARCHAR(5)[] NOT NULL DEFAULT '{"10:00","11:00","13:00","14:00","18:00","19:00","20:00"}'
);

INSERT INTO schedule_settings DEFAULT VALUES;          -- создать единственную строку при миграции
```

---

## 3. API

### Аутентификация

Все клиентские запросы передают заголовок:
```
X-Telegram-Init-Data: <строка initData из window.Telegram.WebApp.initData>
```

Сервер верифицирует каждый запрос:
```
data_check_string = все поля initData кроме hash, отсортированные и соединённые \n
secret_key = HMAC-SHA256(bot_token, "WebAppData")
valid = HMAC-SHA256(secret_key, data_check_string) === hash
```

После верификации из `initData` извлекается `user.id` — это и есть идентификатор клиента.

Для **admin-эндпоинтов** дополнительно: `user.id === ELENA_TG_USER_ID` (переменная окружения).

---

### Клиентские эндпоинты

#### `GET /api/slots?date=YYYY-MM-DD`

Возвращает занятость слотов на конкретную дату. Заменяет `DATA.isSlotBooked()` в `renderSlots()` (`app.js:485`).

**Логика:**
1. Получить `schedule_settings.time_slots`
2. Проверить: дата входит в `available_weekdays`? Если нет — все слоты недоступны
3. Запросить `bookings` где `date = $date AND status = 'upcoming'`
4. Запросить `blocked_slots` где `date = $date`
5. Для каждого слота: `available = не в bookings AND не в blocked_slots`

**Ответ:**
```json
{
  "date": "2026-04-28",
  "slots": [
    { "time": "10:00", "available": true },
    { "time": "11:00", "available": false },
    { "time": "13:00", "available": true },
    { "time": "14:00", "available": false },
    { "time": "18:00", "available": true },
    { "time": "19:00", "available": true },
    { "time": "20:00", "available": false }
  ]
}
```

**Ошибки:** `400` если дата в прошлом или неверный формат.

---

#### `POST /api/bookings`

Создать запись. Вызывается когда пользователь нажимает «Оплатить» / «Подтвердить запись». Заменяет `renderPayment()` в `app.js:638`.

**Тело запроса:**
```json
{
  "service_id": "individual",
  "date": "2026-04-28",
  "time": "19:00",
  "client_name": "Иван",
  "client_request": "Тревога на работе"
}
```

**Логика для `trial` (price = 0):**
1. Проверить слот свободен (SELECT FOR UPDATE чтобы избежать race condition)
2. Вставить booking со статусом `upcoming`, `payment_status = 'free'`
3. Отправить боту команду → бот пишет клиенту подтверждение
4. Вернуть `{ booking_id, status: 'confirmed' }`

**Логика для `individual` и `package` (price > 0):**
1. Проверить слот свободен
2. Вставить booking со статусом `upcoming`, `payment_status = 'pending'`
3. Создать invoice через Telegram Bot API (`sendInvoice`) с `payload = booking_id`
4. Вернуть `{ booking_id, invoice_link: "https://t.me/$bot?start=pay_..." }`
5. Фронтенд открывает invoice через `tg.openInvoice(invoice_link)`

**Ошибки:**
- `409` — слот уже занят (race condition)
- `400` — неверный `service_id` или дата в прошлом
- `422` — дата не рабочий день

---

#### `GET /api/bookings/my`

Список записей текущего пользователя. Заменяет `loadBookings()` из `localStorage` (`app.js:672`).

**Ответ:**
```json
{
  "bookings": [
    {
      "id": 42,
      "service_id": "individual",
      "service_name": "Индивидуальная сессия",
      "duration": "60 мин",
      "date": "2026-04-28",
      "time": "19:00",
      "price_label": "5 000 ₽",
      "status": "upcoming",
      "payment_status": "paid"
    }
  ]
}
```

Поля `service_name`, `duration`, `price_label` возвращает сервер (берёт из словаря услуг) — фронтенду не нужно хранить их отдельно.

---

#### `PATCH /api/bookings/:id/cancel`

Отмена записи. Вызывается из `doCancel()` в `app.js:673`.

**Правила:**
- Только если `tg_user_id` из initData совпадает с владельцем записи
- Только если `status = 'upcoming'`
- Меняет `status → 'cancelled'`
- Если `payment_status = 'paid'` — **не делает автовозврат** (в v1; логику возврата через YooKassa добавить в v2)

**Ответ:** `{ "ok": true }`

**Ошибки:** `403` если чужая запись, `409` если статус не `upcoming`.

---

### Telegram Bot Webhook

#### `POST /bot/webhook`

Единственный endpoint для всех событий от Telegram Bot API.

**`pre_checkout_query`** — Telegram спрашивает разрешение списать деньги:
1. Извлечь `payload` (= `booking_id`)
2. Проверить: запись существует, `payment_status = 'pending'`, слот ещё свободен
3. Ответить `answerPreCheckoutQuery(ok: true)` — иначе оплата не пройдёт

**`successful_payment`** — деньги списаны:
1. Извлечь `payload` (= `booking_id`), `telegram_payment_charge_id`
2. Обновить: `payment_status → 'paid'`, сохранить `tg_payment_charge_id`
3. Отправить клиенту сообщение в чат:
   ```
   ✅ Запись подтверждена!
   
   📅 Пн, 28 апреля · 19:00 — 20:00
   💼 Индивидуальная сессия, 60 мин
   🌐 Онлайн — Telegram Video
   
   Ссылка на видеозвонок придёт за час до начала.
   ```
4. Запланировать напоминание за 24 ч и за 1 ч (см. раздел 5)

---

### Админ-эндпоинты (только Елена)

Доступны если `user.id из initData === ELENA_TG_USER_ID`.

#### `GET /admin/bookings`

Все записи, отсортированные по `date ASC, time ASC`. Опциональные фильтры: `?status=upcoming`, `?date=2026-04-28`.

**Ответ:** массив booking-объектов с `client_name`, `client_request`, `tg_user_id`, `payment_status`.

---

#### `GET /admin/slots/blocked`

Список заблокированных слотов. Опционально: `?from=2026-04-28&to=2026-05-05`.

---

#### `POST /admin/slots/block`

Заблокировать слот или весь день.

**Тело:**
```json
{ "date": "2026-05-01", "time": "19:00", "reason": "Личное" }
```
Если `time` не передан — блокируется весь день (`time = NULL` в `blocked_slots`).

---

#### `DELETE /admin/slots/block/:id`

Разблокировать слот.

---

#### `PATCH /admin/settings`

Изменить рабочие дни или временные слоты.

**Тело:**
```json
{
  "available_weekdays": [1, 2, 3, 4, 5],
  "time_slots": ["10:00", "13:00", "18:00", "19:00", "20:00"]
}
```

---

## 4. Telegram Payments — полный флоу

```
Клиент нажимает «Оплатить 5 000 ₽»
     │
     ▼
POST /api/bookings
  → запись создана (status=upcoming, payment_status=pending)
  → сервер вызывает bot.sendInvoice(user_id, { payload: booking_id, ... })
  → возвращает { invoice_link }
     │
     ▼
Фронтенд: tg.openInvoice(invoice_link)
  → пользователь видит нативный платёжный экран Telegram
     │
     ▼
Telegram → POST /bot/webhook { pre_checkout_query }
  → сервер проверяет booking_id, слот свободен
  → answerPreCheckoutQuery(ok: true)
     │
     ▼
Пользователь подтверждает оплату в Telegram
     │
     ▼
Telegram → POST /bot/webhook { successful_payment }
  → payment_status → 'paid'
  → бот пишет подтверждение в чат
  → планируются напоминания
     │
     ▼
Фронтенд: WebApp.onEvent('invoiceClosed', ({ status }) => {
  if (status === 'paid') navigate('success')
})
```

**Провайдер оплаты:** YooKassa (подключается в BotFather как Payments Provider).

**Для пробной сессии (price = 0):** invoice не создаётся. После `POST /api/bookings` сервер сразу создаёт подтверждённую запись и пишет клиенту. Фронтенд переходит на экран успеха напрямую.

---

## 5. Бот-уведомления

Все уведомления отправляются через `bot.sendMessage(tg_user_id, text)`.

| Триггер | Когда | Текст |
|---|---|---|
| Запись подтверждена | Сразу после `successful_payment` или после создания пробной | ✅ с деталями сессии |
| Напоминание | За 24 ч до `date + time` | «Завтра в 19:00 — сессия с Еленой. Всё в силе?» |
| Ссылка на встречу | За 1 ч до `date + time` | «Через час ваша сессия. Ссылка: [ссылка]» |
| Запись отменена клиентом | После `PATCH /bookings/:id/cancel` | «Ваша запись на 28 апреля отменена» |

**Реализация напоминаний:** node-cron-задача, которая каждые 5 минут проверяет `bookings` и отправляет уведомления для записей у которых `date + time` входит в нужный интервал и флаг `reminder_24h_sent` / `reminder_1h_sent` ещё не установлен.

Добавить в таблицу `bookings`:
```sql
ALTER TABLE bookings ADD COLUMN reminder_24h_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN reminder_1h_sent  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN meet_link         VARCHAR(500);  -- ссылка на видеозвонок
```

---

## 6. Что нужно изменить во фронтенде

Изменений минимум — только замена источников данных.

| Функция в `app.js` | Что изменить |
|---|---|
| `DATA.isSlotBooked()` в `renderSlots()` (строка 485) | Заменить на `GET /api/slots?date=` с кешированием результата на время сессии |
| `renderPayment()` (строка 638) | Заменить setTimeout на `POST /api/bookings` → для платных услуг `tg.openInvoice()` |
| `saveBooking()` и `persistBookings()` (строки 654–669) | Убрать запись в localStorage; список записей тянуть с `GET /api/bookings/my` |
| `loadBookings()` (строка 672) | Заменить на вызов API |
| `doCancel()` (строка 673) | Добавить вызов `PATCH /api/bookings/:id/cancel` перед `renderMyBookings()` |
| Инициализация (строка 835) | После верификации пользователя тянуть `GET /api/bookings/my` вместо `localStorage` |

Всё остальное (навигация, рендеринг, квиз, тест тревожности) **не меняется** — данные для этого статичные.

---

## 7. Технический стек

| Слой | Технология | Почему |
|---|---|---|
| Сервер | Node.js + Fastify | Указан в `CLAUDE.md`; быстрый, минимальный бойлерплейт |
| База данных | PostgreSQL | Указан в `CLAUDE.md` |
| Telegram Bot | `node-telegram-bot-api` или `grammY` | Указаны в `CLAUDE.md` |
| Платежи | YooKassa | Указан в `CLAUDE.md` и `research.md`; работает в России |
| Хостинг | VPS с HTTPS | Обязательно для Telegram Mini App и Bot webhook |
| Планировщик | node-cron | Напоминания; встроен в тот же процесс, не нужен отдельный воркер |

---

## 8. Переменные окружения

```
BOT_TOKEN=          # токен от @BotFather
YOOKASSA_SHOP_ID=   # ID магазина YooKassa
YOOKASSA_SECRET=    # секретный ключ YooKassa
ELENA_TG_USER_ID=   # Telegram user.id Елены — для доступа к /admin/*
DATABASE_URL=       # postgresql://user:pass@host:5432/dbname
WEBHOOK_URL=        # https://yourdomain.com/bot/webhook
```

---

## 9. Порядок реализации

| Этап | Что делать | Что даёт |
|---|---|---|
| 1 | Таблицы `bookings`, `blocked_slots`, `schedule_settings`. POST /api/bookings для `trial`. GET /api/bookings/my. PATCH cancel. | Записи сохраняются на сервере, не теряются |
| 2 | GET /api/slots с реальными данными из `bookings`. | Занятость слотов отражает реальность |
| 3 | Telegram Payments: sendInvoice, pre_checkout_query, successful_payment. | Реальная оплата |
| 4 | Бот-сообщения: подтверждение сразу + cron-напоминания за 24ч и 1ч. | Клиент получает уведомления |
| 5 | /admin/* эндпоинты + блокировка слотов. | Елена управляет расписанием |
