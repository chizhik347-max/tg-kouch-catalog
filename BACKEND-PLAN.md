# BACKEND-PLAN.md — Универсальная платформа для мастеров (v2)

> Один сервер, много мастеров, у каждого свой бот и своё Mini App.  
> Мастер регистрируется сам, заполняет профиль через пошаговый диалог.  
> Клиенты видят только своего мастера.

---

## 0. Как это работает

```
Мастер                          Платформа                        Клиент
──────                          ─────────                        ──────
1. Создаёт бота в @BotFather    /register + токен              5. Открывает бота мастера
2. Отправляет токен             → создаёт запись               6. Mini App загружает
   платформенному боту          → ставит webhook                  GET /api/v1/master/42
3. Отвечает на вопросы          → хранит профиль               7. Записывается
   (пошагово, по одному)        → настраивает кнопку           8. Платит (если платно)
4. Получает ссылку              → url: /app?m=42               9. Получает уведомление
   на своё приложение
```

---

## 1. База данных

### Таблица `masters`

```sql
CREATE TABLE masters (
  id               SERIAL PRIMARY KEY,
  bot_token        VARCHAR(120)  NOT NULL UNIQUE,
  bot_username     VARCHAR(60),
  webhook_secret   VARCHAR(64)   NOT NULL,
  -- Случайная строка, генерируется при регистрации.
  -- Передаётся в setWebhook как secret_token.
  -- Telegram шлёт её в заголовке X-Telegram-Bot-Api-Secret-Token.
  -- Токен бота НИКОГДА не попадает в URL.

  admin_tg_user_id BIGINT        NOT NULL UNIQUE,

  -- Профиль
  name             VARCHAR(100)  NOT NULL DEFAULT '',
  first_name       VARCHAR(50)   NOT NULL DEFAULT '',
  initials         VARCHAR(5)    NOT NULL DEFAULT '',
  title            VARCHAR(150)  NOT NULL DEFAULT '',
  about            TEXT          NOT NULL DEFAULT '',
  photo_url        VARCHAR(500),
  contact_handle   VARCHAR(60),

  -- Статистика (мастер обновляет вручную через команду)
  rating           NUMERIC(3,1)  NOT NULL DEFAULT 5.0,
  clients_count    INT           NOT NULL DEFAULT 0,
  sessions_count   INT           NOT NULL DEFAULT 0,

  -- Простые списки: ['МГУ, психфак, 2015', 'КПТ, 2022']
  specializations  TEXT[]        NOT NULL DEFAULT '{}',
  education        TEXT[]        NOT NULL DEFAULT '{}',

  -- Включённые функции Mini App
  -- Пример: {"anxietyTest": true, "onboardingQuiz": false}
  features         JSONB         NOT NULL DEFAULT '{}',

  -- Онбординг
  setup_step       VARCHAR(20)   NOT NULL DEFAULT 'awaiting_token',
  -- 'awaiting_token' → 'name' → 'title' → 'photo' → 'about'
  -- → 'specializations' → 'services' → 'schedule' → 'done'
  is_active        BOOLEAN       NOT NULL DEFAULT FALSE,

  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

---

### Таблица `services`

```sql
CREATE TABLE services (
  id           SERIAL PRIMARY KEY,
  master_id    INT          NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_key  VARCHAR(40)  NOT NULL,
  name         VARCHAR(100) NOT NULL,
  duration_min INT          NOT NULL DEFAULT 60,
  price        INT          NOT NULL DEFAULT 0,  -- рубли, 0 = бесплатно
  format       VARCHAR(50)  NOT NULL DEFAULT 'Онлайн',
  icon         VARCHAR(10)  NOT NULL DEFAULT '💼',
  badge        VARCHAR(80),
  description  TEXT,
  includes     TEXT[]       NOT NULL DEFAULT '{}',
  for_whom     TEXT[]       NOT NULL DEFAULT '{}',
  sort_order   SMALLINT     NOT NULL DEFAULT 0,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,

  UNIQUE (master_id, service_key)
);
```

---

### Таблица `reviews`

```sql
CREATE TABLE reviews (
  id          SERIAL PRIMARY KEY,
  master_id   INT          NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  client_name VARCHAR(80)  NOT NULL,
  rating      SMALLINT     NOT NULL DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
  text        TEXT         NOT NULL,
  date_label  VARCHAR(40)  NOT NULL DEFAULT '2 недели назад',
  sort_order  SMALLINT     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

---

### Таблица `schedule`

Фиксирует нагрузку: одно расписание на мастера.

```sql
CREATE TABLE schedule (
  master_id             INT    NOT NULL PRIMARY KEY REFERENCES masters(id) ON DELETE CASCADE,

  -- Рабочие дни по умолчанию (0=Вс, 1=Пн … 6=Сб)
  available_weekdays    INT[]  NOT NULL DEFAULT '{1,2,3,4,5,6}',

  -- Слоты по умолчанию — применяются ко всем рабочим дням
  default_time_slots    TEXT[] NOT NULL DEFAULT '{10:00,13:00,18:00}',

  -- Переопределение слотов по конкретному дню недели
  -- Формат: {"1": ["10:00","11:00"], "6": ["12:00"]}
  -- Ключ "1" = понедельник. Переопределяет default_time_slots для этого дня.
  day_overrides         JSONB  NOT NULL DEFAULT '{}'
);
```

**Логика получения слотов для даты:**
```
1. Определить день недели (dow) для запрошенной даты
2. Если dow не в available_weekdays → слотов нет
3. Если dow есть в day_overrides → взять слоты оттуда
4. Иначе → взять default_time_slots
5. Вычесть занятые (bookings WHERE date=X AND status='upcoming')
6. Вычесть заблокированные (blocked_slots WHERE date=X)
```

---

### Таблица `blocked_slots`

```sql
CREATE TABLE blocked_slots (
  id          SERIAL PRIMARY KEY,
  master_id   INT         NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  date        DATE        NOT NULL,
  time        VARCHAR(5),           -- NULL = весь день заблокирован
  reason      VARCHAR(200),
  UNIQUE (master_id, date, time)
);
```

---

### Таблица `bookings`

```sql
CREATE TABLE bookings (
  id                   SERIAL PRIMARY KEY,
  master_id            INT          NOT NULL REFERENCES masters(id),
  tg_user_id           BIGINT       NOT NULL,
  client_name          VARCHAR(100) NOT NULL,
  client_request       TEXT,
  service_id           INT          NOT NULL REFERENCES services(id),
  -- При создании дополнительно проверяем: services.master_id = bookings.master_id
  date                 DATE         NOT NULL,
  time                 VARCHAR(5)   NOT NULL,
  status               VARCHAR(20)  NOT NULL DEFAULT 'upcoming',
  -- 'upcoming' | 'past' | 'cancelled'
  payment_status       VARCHAR(20)  NOT NULL DEFAULT 'free',
  -- 'free' | 'pending' | 'paid' | 'refunded'
  tg_payment_charge_id VARCHAR(100),
  reminder_24h_sent    BOOLEAN      NOT NULL DEFAULT FALSE,
  reminder_1h_sent     BOOLEAN      NOT NULL DEFAULT FALSE,
  meet_link            VARCHAR(300),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Один активный слот на мастера = одна запись
CREATE UNIQUE INDEX bookings_slot_unique
  ON bookings (master_id, date, time)
  WHERE status = 'upcoming';

CREATE INDEX ON bookings (master_id, tg_user_id);
CREATE INDEX ON bookings (master_id, date, status);
-- Для cron напоминаний:
CREATE INDEX ON bookings (date, time, status, reminder_24h_sent, reminder_1h_sent);
```

---

## 2. Безопасность

### 2.1 Webhook — без токена в URL

**Регистрация вебхука при создании мастера:**
```js
const webhookSecret = crypto.randomBytes(32).toString('hex'); // 64 символа

await bot.setWebhook({
  url: `https://api.platform.com/api/v1/webhook/${master.id}`,
  secret_token: webhookSecret,
});

await db.query(
  'UPDATE masters SET webhook_secret = $1 WHERE id = $2',
  [webhookSecret, master.id]
);
```

**Обработка входящего вебхука:**
```js
app.post('/api/v1/webhook/:masterId', async (req, res) => {
  const master = await db.masters.findById(req.params.masterId);
  if (!master) return res.sendStatus(404);

  const incoming = req.headers['x-telegram-bot-api-secret-token'];
  if (incoming !== master.webhook_secret) return res.sendStatus(403);

  await handleUpdate(master, req.body);
  res.sendStatus(200);
});
```

Токен бота (`bot_token`) никогда не попадает в URL, в логи и в сеть.

---

### 2.2 Верификация initData от Mini App

```js
function verifyInitData(initDataRaw, botToken) {
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const expected = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (hash !== expected) throw new Error('Invalid initData');

  // Проверяем свежесть (не старше 1 часа)
  const authDate = Number(params.get('auth_date'));
  if (Date.now() / 1000 - authDate > 3600) throw new Error('initData expired');

  return JSON.parse(params.get('user'));
}
```

Middleware для защищённых роутов:
```js
async function requireClient(req, res, next) {
  try {
    const master = await db.masters.findById(req.params.masterId);
    if (!master) return res.sendStatus(404);

    req.tgUser = verifyInitData(req.headers['x-telegram-init-data'], master.bot_token);
    req.master = master;
    next();
  } catch {
    res.sendStatus(401);
  }
}
```

---

### 2.3 Rate limiting

```js
import rateLimit from 'express-rate-limit';

// Общий лимит: 60 запросов/мин с одного IP
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60 }));

// Создание записи: не более 5 за 10 минут с одного tg_user_id
// Проверяется в обработчике POST /bookings:
const recent = await db.query(
  `SELECT COUNT(*) FROM bookings
   WHERE tg_user_id = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
  [req.tgUser.id]
);
if (recent.rows[0].count >= 5) return res.status(429).json({ error: 'Слишком много запросов' });
```

---

## 3. API v1

Базовый путь: `/api/v1`

Все запросы от Mini App содержат:
```
X-Telegram-Init-Data: <raw initData>
```

---

### `GET /api/v1/master/:masterId`

Публичный. Возвращает всё для первой загрузки. `next_slot` вычисляется динамически.

**Ответ 200:**
```json
{
  "specialist": {
    "name": "Иван Иванов",
    "firstName": "Иван",
    "initials": "ИИ",
    "title": "Массажист · Релаксация и восстановление",
    "about": "...",
    "photo_url": "https://i.imgur.com/xyz.jpg",
    "rating": 4.9,
    "clients": 150,
    "sessions": 400,
    "nextSlot": "завтра 10:00",
    "contactHandle": "ivan_massage",
    "botHandle": "ivan_massage_bot"
  },
  "services": [
    {
      "id": 42,
      "serviceKey": "classic",
      "name": "Классический массаж",
      "durationMin": 60,
      "price": 3000,
      "priceLabel": "3 000 ₽",
      "format": "Очно",
      "icon": "💆",
      "badge": "Популярное",
      "description": "...",
      "includes": ["Разогрев мышц", "Работа со спиной", "Расслабляющий финал"],
      "forWhom": ["Стресс", "Боли в спине"]
    }
  ],
  "reviews": [...],
  "schedule": {
    "availableWeekdays": [1, 2, 3, 4, 5, 6],
    "defaultTimeSlots": ["10:00", "13:00", "18:00"],
    "dayOverrides": { "6": ["10:00", "12:00"] }
  },
  "features": {
    "anxietyTest": false,
    "onboardingQuiz": false
  }
}
```

**Вычисление `nextSlot`** (в коде сервера):
```js
async function computeNextSlot(masterId) {
  const schedule = await db.schedule.findByMaster(masterId);
  const today = new Date();

  for (let offset = 0; offset < 14; offset++) {
    const date = addDays(today, offset);
    const dow = date.getDay();
    if (!schedule.available_weekdays.includes(dow)) continue;

    const slots = schedule.day_overrides[dow] ?? schedule.default_time_slots;
    const booked = await db.bookings.getBusySlots(masterId, formatDate(date));
    const blocked = await db.blockedSlots.getByDate(masterId, formatDate(date));
    const busySet = new Set([...booked, ...blocked]);

    const free = slots.filter(t => !busySet.has(t));
    if (free.length > 0) {
      return offset === 0 ? `сегодня ${free[0]}` : `${formatDayLabel(date)} ${free[0]}`;
    }
  }
  return 'скоро';
}
```

---

### `GET /api/v1/master/:masterId/slots?date=YYYY-MM-DD`

Публичный. Слоты для конкретной даты.

**Ответ 200:**
```json
{
  "date": "2026-05-15",
  "slots": [
    { "time": "10:00", "available": true },
    { "time": "13:00", "available": false },
    { "time": "18:00", "available": true }
  ]
}
```

---

### `POST /api/v1/master/:masterId/bookings` 🔒

Требует `requireClient` middleware.

**Тело:**
```json
{
  "serviceId": 42,
  "date": "2026-05-15",
  "time": "10:00",
  "clientName": "Анна",
  "clientRequest": "Боли в пояснице"
}
```

**Логика (в порядке выполнения):**
```
1. verifyInitData → получаем tg_user_id
2. Rate limit: не более 5 записей за 10 минут с этого tg_user_id
3. Проверяем что services.id = :serviceId AND services.master_id = :masterId
   (изоляция: нельзя записаться к чужому мастеру)
4. Проверяем что слот свободен (нет в bookings и blocked_slots)
5. INSERT INTO bookings — в транзакции (UNIQUE INDEX отклонит гонку)
6. Если service.price = 0:
   → status = 'upcoming', payment_status = 'free'
   → уведомить мастера: «Новая запись от Анны — 15 мая 10:00»
   → ответить: { bookingId, paymentRequired: false }
7. Если service.price > 0:
   → status = 'pending', payment_status = 'pending'
   → sendInvoice клиенту через бота мастера
   → ответить: { bookingId, paymentRequired: true }
```

**Ответ 201:**
```json
{ "bookingId": 123, "paymentRequired": false }
```

**Ошибки:**
- `409` — слот уже занят
- `422` — услуга не принадлежит этому мастеру
- `429` — слишком много записей

---

### `GET /api/v1/master/:masterId/bookings` 🔒

Записи текущего пользователя (только его `tg_user_id`).

**Ответ 200:**
```json
{
  "bookings": [
    {
      "id": 123,
      "service": "Классический массаж",
      "durationMin": 60,
      "date": "2026-05-15",
      "time": "10:00",
      "status": "upcoming",
      "paymentStatus": "free",
      "meetLink": null
    }
  ]
}
```

---

### `PATCH /api/v1/master/:masterId/bookings/:id/cancel` 🔒

Только свою запись. Только статус `upcoming`.

```sql
UPDATE bookings
SET status = 'cancelled'
WHERE id = $1
  AND master_id = $2
  AND tg_user_id = $3
  AND status = 'upcoming'
```

Если затронуто 0 строк → `404`.

---

### `POST /api/v1/webhook/:masterId` (Telegram)

Принимает все апдейты от бота мастера.

Виды апдейтов:
- `message` — команда от клиента или мастера
- `pre_checkout_query` — до оплаты (ответить в течение 10 сек)
- `successful_payment` — оплата прошла

**pre_checkout_query:**
```js
await sendRequest(master.bot_token, 'answerPreCheckoutQuery', {
  pre_checkout_query_id: query.id,
  ok: true,
});
```

**successful_payment:**
```js
const { invoice_payload, telegram_payment_charge_id } = payment;
const bookingId = invoice_payload.replace('booking:', '');

await db.query(`
  UPDATE bookings
  SET status = 'upcoming',
      payment_status = 'paid',
      tg_payment_charge_id = $1
  WHERE id = $2 AND master_id = $3
`, [telegram_payment_charge_id, bookingId, master.id]);

// Уведомить клиента
await sendMessage(master.bot_token, userId, 'Оплата прошла ✓ Ждём вас!');
// Уведомить мастера
await sendMessage(master.bot_token, master.admin_tg_user_id, `Оплата получена от ${clientName}`);
```

---

## 4. Онбординг мастера

### Шаги (один вопрос — одно поле)

Платформенный бот ведёт мастера пошагово. Каждый шаг сохраняет одно поле и переходит к следующему.

```
/start
→ «Привет! Чтобы создать приложение, пришли токен своего бота.
   Как его получить: откройте @BotFather → /newbot → скопируйте токен.»

← [токен от мастера]
→ Проверяем через getMe()
→ Если ошибка: «Токен не подходит, попробуй ещё раз»
→ Если ок:
   - Создаём запись в masters (webhook_secret = random)
   - setWebhook(url=/api/v1/webhook/{id}, secret_token=webhook_secret)
   - setup_step = 'name'
   - «Отлично! Как вас зовут? Напишите имя и фамилию.»
   - Пример: Иван Иванов

← «Иван Иванов»
→ masters.name = 'Иван Иванов', masters.first_name = 'Иван'
→ masters.initials = 'ИИ' (автоматически)
→ setup_step = 'title'
→ «Ваша специализация — одна строка.
   Пример: Массажист · Релаксация и восстановление»

← «Массажист · Спортивное восстановление»
→ masters.title = ...
→ setup_step = 'photo'
→ «Ссылка на ваше фото (прямой URL, jpg/png).
   Пример: https://i.imgur.com/abc.jpg
   Нет ссылки? Напишите "пропустить" — покажем инициалы.»

← URL или «пропустить»
→ masters.photo_url = URL или null
→ setup_step = 'about'
→ «Расскажите о себе — 2–3 абзаца. Клиент прочитает это в приложении.
   Совет: напишите о своём подходе, опыте и как вы помогаете.»

← текст
→ masters.about = текст
→ setup_step = 'specializations'
→ «Ваши направления через запятую.
   Пример: Спина, Шея, Суставы, Стресс»

← «Спина, Шея, Суставы»
→ masters.specializations = ['Спина', 'Шея', 'Суставы']
→ setup_step = 'services'
→ «Добавим услуги. Опишите первую по шаблону:
   
   Название | Длительность (мин) | Цена (руб) | Формат
   
   Пример:
   Классический массаж | 60 | 3000 | Очно
   Консультация | 30 | 0 | Онлайн»
```

**Парсинг услуги:**
```js
function parseServiceLine(text) {
  const parts = text.split('|').map(s => s.trim());
  if (parts.length < 4) throw new Error('Нужно 4 части через |');

  const [name, durationStr, priceStr, format] = parts;
  const duration = parseInt(durationStr);
  const price = parseInt(priceStr);

  if (!name || isNaN(duration) || isNaN(price))
    throw new Error('Не могу разобрать. Проверь формат.');

  return { name, duration_min: duration, price, format };
}
```

Если парсинг не удался — бот отвечает конкретной ошибкой и просит повторить.

```
← «Классический массаж | 60 | 3000 | Очно»
→ Сохраняем услугу
→ «Услуга добавлена ✓
   Добавить ещё? Напишите следующую или "готово".»

← «готово»
→ setup_step = 'schedule'
→ «Рабочие дни — напишите через запятую:
   Пн Вт Ср Чт Пт Сб Вс
   
   Пример: Пн, Вт, Ср, Пт, Сб»

← «Пн, Вт, Ср, Пт, Сб»
→ schedule.available_weekdays = [1,2,3,4,5,6] (без Вс=0)
→ «Теперь рабочие часы — через пробел:
   Пример: 10:00 12:00 15:00 18:00»

← «10:00 13:00 18:00»
→ schedule.default_time_slots = ['10:00', '13:00', '18:00']
→ setup_step = 'done', is_active = true

→ Настраиваем бота:
   - setChatMenuButton → ЗАПИСАТЬСЯ → /app?m={id}
   - setMyDescription, setMyCommands

→ «🎉 Готово! Ваше приложение работает.
   
   Ссылка для клиентов: t.me/{bot_username}
   
   Команды в вашем боте:
   /dashboard — записи на сегодня
   /bookings  — все предстоящие
   /block     — заблокировать день или слот
   /link      — ссылка для поделиться»
```

---

## 5. Команды мастера в своём боте

Система определяет, что это мастер: `update.message.from.id === master.admin_tg_user_id`.

| Команда | Действие |
|---|---|
| `/dashboard` | Сколько записей сегодня и завтра, последние 3 клиента |
| `/bookings` | Список ближайших записей: дата, время, имя, услуга |
| `/block 2026-05-15` | Заблокировать весь день |
| `/block 2026-05-15 10:00` | Заблокировать один слот |
| `/unblock 2026-05-15` | Разблокировать день или слот |
| `/meet 123 https://zoom.us/...` | Добавить meet_link к записи #123 |
| `/addreview` | Диалог добавления отзыва (имя → оценка → текст) |
| `/stats` | Клиентов за месяц, выручка |
| `/link` | Ссылка на приложение для распространения |
| `/editprofile` | Меню изменения: имя / фото / о себе / специализации |

---

## 6. Уведомления клиенту

Все сообщения идут от бота мастера. Клиент видит персональный бренд мастера.

| Событие | Сообщение |
|---|---|
| Запись (бесплатно) | «Запись подтверждена ✅\n📅 15 мая, 10:00\n💼 Классический массаж\nСсылка придёт за час до начала.» |
| Оплата прошла | «Оплата получена ✓\nДо встречи 15 мая в 10:00!» |
| Напоминание −24 ч | «Напоминаем: завтра в 10:00 — [услуга] у [имя мастера]» |
| Напоминание −1 ч | «Через час ваша сессия.\n🔗 [meet_link]» |
| Отмена | «Ваша запись на 15 мая отменена.» |

---

## 7. Cron-задачи

**Проблема:** Railway может усыплять сервер. Решение — при каждом запуске догонять пропущенные задачи.

```js
// Запускается каждые 15 минут
cron.schedule('*/15 * * * *', sendReminders);

async function sendReminders() {
  const now = new Date();

  // Напоминания за 24 часа
  const tomorrow = addHours(now, 24);
  const due24 = await db.query(`
    SELECT b.*, m.bot_token
    FROM bookings b
    JOIN masters m ON m.id = b.master_id
    WHERE b.status = 'upcoming'
      AND b.reminder_24h_sent = FALSE
      AND (b.date + b.time::time) BETWEEN $1 AND $2
  `, [now, tomorrow]);

  for (const b of due24.rows) {
    await sendMessage(b.bot_token, b.tg_user_id, formatReminder24(b));
    await db.query('UPDATE bookings SET reminder_24h_sent = TRUE WHERE id = $1', [b.id]);
  }

  // Напоминания за 1 час
  const inOneHour = addHours(now, 1);
  const due1h = await db.query(`
    SELECT b.*, m.bot_token
    FROM bookings b
    JOIN masters m ON m.id = b.master_id
    WHERE b.status = 'upcoming'
      AND b.reminder_1h_sent = FALSE
      AND (b.date + b.time::time) BETWEEN $1 AND $2
  `, [now, inOneHour]);

  for (const b of due1h.rows) {
    await sendMessage(b.bot_token, b.tg_user_id, formatReminder1h(b));
    await db.query('UPDATE bookings SET reminder_1h_sent = TRUE WHERE id = $1', [b.id]);
  }
}
```

На Railway — включить Railway Cron Jobs как дублирующий триггер.

---

## 8. Frontend — изменения в Mini App

### Как Mini App определяет мастера

**Способ 1 — URL-параметр (основной):**
```js
const masterId = new URLSearchParams(window.location.search).get('m');
```

Кнопка меню мастера настраивается на `https://platform.com/app?m={id}`.

**Способ 2 — start_param (fallback):**
```js
const startParam = tg?.initDataUnsafe?.start_param; // 'app_42'
const masterId = startParam?.startsWith('app_') ? startParam.slice(4) : null;
```

### Загрузка данных (заменяет data.js)

```js
async function loadMasterData(masterId) {
  const res = await fetch(`/api/v1/master/${masterId}`, {
    headers: { 'X-Telegram-Init-Data': tg?.initData || '' }
  });
  if (!res.ok) throw new Error('Не удалось загрузить данные');
  return res.json();  // заменяет весь объект DATA
}
```

### Опциональные функции (features)

```js
// После загрузки данных:
if (!DATA.features.anxietyTest) {
  document.getElementById('anxiety-banner')?.remove();
  // убираем экраны anxietyTest и anxietyResult из навигации
}

if (!DATA.features.onboardingQuiz) {
  // Пропускаем quiz → сразу home после welcome
}
```

GAD-7 и квиз психолога — по умолчанию выключены (`features: {}`). Психолог включает их через `/editprofile`.

### Фото мастера

```js
function renderAvatar(el, specialist) {
  if (specialist.photo_url) {
    el.innerHTML = `<img src="${specialist.photo_url}"
                        alt="${specialist.initials}"
                        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    el.textContent = specialist.initials;
  }
}
```

---

## 9. Tech Stack

| Слой | Технология | Почему |
|---|---|---|
| Backend | Node.js + Express | Один язык с фронтом |
| БД | PostgreSQL | JSONB, ACID, UNIQUE INDEX |
| Драйвер | node-postgres (pg) | Прямой SQL, без ORM |
| Хостинг | Railway | PostgreSQL бесплатно + Node.js |
| Cron | node-cron + Railway Cron | Дублирование на случай сна сервера |
| Безопасность | express-rate-limit | Rate limiting |

---

## 10. Переменные окружения

```env
# Платформенный бот (для онбординга мастеров)
PLATFORM_BOT_TOKEN=...

# База данных
DATABASE_URL=postgresql://user:pass@host:5432/platform

# Публичные URL
API_BASE_URL=https://api.platform.com
MINI_APP_URL=https://platform.com/app

# Окружение
NODE_ENV=production
PORT=3000
```

Токены ботов мастеров — только в таблице `masters.bot_token` в БД.

---

## 11. Стадии разработки

### Стадия 1 — Один мастер читает (2 дня)
- [ ] Таблицы: masters, services, reviews, schedule
- [ ] `GET /api/v1/master/:id` с динамическим `nextSlot`
- [ ] `GET /api/v1/master/:id/slots`
- [ ] Mini App: заменить `data.js` на fetch, обработка ошибок загрузки
- [ ] Фото-аватар в Mini App

### Стадия 2 — Клиент записывается (2 дня)
- [ ] Таблица bookings + blocked_slots
- [ ] `POST /api/v1/master/:id/bookings` с полной валидацией
- [ ] `GET /api/v1/master/:id/bookings`
- [ ] `PATCH cancel`
- [ ] Webhook: принимает апдейты, уведомляет мастера о новой записи
- [ ] Rate limiting

### Стадия 3 — Мастер управляет (2 дня)
- [ ] Команды: `/dashboard`, `/bookings`, `/block`, `/unblock`, `/link`
- [ ] Добавление отзывов через `/addreview`
- [ ] Редактирование профиля через `/editprofile`

### Стадия 4 — Онбординг нового мастера (2 дня)
- [ ] Платформенный бот: пошаговый диалог регистрации
- [ ] Автонастройка webhook, MenuButton, описание и команды бота
- [ ] Парсинг и валидация каждого шага с понятными ошибками

### Стадия 5 — Оплата (2 дня)
- [ ] Telegram Payments: sendInvoice → pre_checkout → successful_payment
- [ ] Обновление статусов, уведомления обеим сторонам

### Стадия 6 — Надёжность (1 день)
- [ ] Cron-напоминания с catch-up логикой
- [ ] Railway Cron Jobs как дублер
- [ ] `/meet` команда для ссылок на звонок
- [ ] Опциональные features (anxietyTest, onboardingQuiz)
