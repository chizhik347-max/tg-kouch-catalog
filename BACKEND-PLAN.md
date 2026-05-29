# BACKEND-PLAN.md — Универсальная платформа для мастеров

> Один сервер, много мастеров, у каждого свой бот и своё Mini App.  
> Мастер регистрируется сам, заполняет профиль через бота, клиенты видят только его.

---

## 0. Как это работает — одной картинкой

```
Мастер                     Платформа                    Клиент
──────                     ─────────                    ──────
1. Создаёт бота             /register <token>           4. Открывает бота мастера
   в @BotFather          → регистрирует мастера         5. Видит его профиль
2. Вводит токен          → ставит webhook               6. Записывается
3. Заполняет профиль     → хранит данные                7. Платит
   через своего бота     → уведомляет бота              8. Получает подтверждение
```

Каждый бот мастера — это и клиентский интерфейс, и его личная CRM.

---

## 1. База данных

### Таблица `masters`

Один мастер = одна строка. Центральная таблица платформы.

```sql
CREATE TABLE masters (
  id                SERIAL PRIMARY KEY,
  bot_token         VARCHAR(120) NOT NULL UNIQUE,  -- токен от @BotFather
  bot_username      VARCHAR(60),                   -- username бота (из getMe)
  admin_tg_user_id  BIGINT NOT NULL UNIQUE,        -- tg_user_id владельца
  
  -- Профиль (заполняет мастер)
  name              VARCHAR(100) NOT NULL DEFAULT '',
  first_name        VARCHAR(50)  NOT NULL DEFAULT '',
  initials          VARCHAR(5)   NOT NULL DEFAULT '',
  title             VARCHAR(150) NOT NULL DEFAULT '',
  about             TEXT         NOT NULL DEFAULT '',
  photo_url         VARCHAR(500),                  -- прямая ссылка на фото
  contact_handle    VARCHAR(60),                   -- @username мастера в TG
  
  -- Статистика (обновляется мастером вручную)
  rating            NUMERIC(3,1) NOT NULL DEFAULT 5.0,
  clients_count     INT          NOT NULL DEFAULT 0,
  sessions_count    INT          NOT NULL DEFAULT 0,
  
  -- Специализации и образование
  specializations   TEXT[]       NOT NULL DEFAULT '{}',
  education         JSONB        NOT NULL DEFAULT '[]',
  -- Формат: [{"icon": "🎓", "text": "МГУ, 2015"}]
  
  -- Состояние онбординга
  setup_step        VARCHAR(20)  NOT NULL DEFAULT 'token',
  -- 'token' → 'profile' → 'services' → 'schedule' → 'done'
  is_active         BOOLEAN      NOT NULL DEFAULT FALSE,
  
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

---

### Таблица `services`

Каждый мастер настраивает свои услуги. Нет ограничения на тип ниши.

```sql
CREATE TABLE services (
  id           SERIAL PRIMARY KEY,
  master_id    INT          NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_key  VARCHAR(40)  NOT NULL,      -- 'trial' | 'consultation' | любой
  name         VARCHAR(100) NOT NULL,
  duration_min INT          NOT NULL DEFAULT 60,
  price        INT          NOT NULL DEFAULT 0,   -- в рублях, 0 = бесплатно
  format       VARCHAR(50)  NOT NULL DEFAULT 'Онлайн',
  icon         VARCHAR(10)  NOT NULL DEFAULT '💼',
  badge        VARCHAR(80),                -- «Популярное», «+бонус» и т.д.
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

Отзывы добавляет мастер (через бота), чтобы витрина выглядела живой.

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

Одна строка на мастера — его рабочие дни и слоты.

```sql
CREATE TABLE schedule (
  master_id          INT     NOT NULL PRIMARY KEY REFERENCES masters(id) ON DELETE CASCADE,
  available_weekdays INT[]   NOT NULL DEFAULT '{1,2,3,4,5,6}',
  -- 0=Вс, 1=Пн … 6=Сб
  time_slots         TEXT[]  NOT NULL DEFAULT '{10:00,11:00,13:00,14:00,18:00,19:00,20:00}',
  next_slot_label    VARCHAR(60) NOT NULL DEFAULT 'скоро'
  -- Мастер сам обновляет: «сегодня 19:00», «завтра 10:00»
);
```

---

### Таблица `bookings`

Все записи всех мастеров — разделяются по `master_id`.

```sql
CREATE TABLE bookings (
  id                    SERIAL PRIMARY KEY,
  master_id             INT          NOT NULL REFERENCES masters(id),
  tg_user_id            BIGINT       NOT NULL,
  client_name           VARCHAR(100) NOT NULL,
  client_request        TEXT,
  service_id            INT          NOT NULL REFERENCES services(id),
  date                  DATE         NOT NULL,
  time                  VARCHAR(5)   NOT NULL,
  status                VARCHAR(20)  NOT NULL DEFAULT 'upcoming',
  -- 'upcoming' | 'past' | 'cancelled'
  payment_status        VARCHAR(20)  NOT NULL DEFAULT 'free',
  -- 'free' | 'pending' | 'paid' | 'refunded'
  tg_payment_charge_id  VARCHAR(100),
  reminder_24h_sent     BOOLEAN      NOT NULL DEFAULT FALSE,
  reminder_1h_sent      BOOLEAN      NOT NULL DEFAULT FALSE,
  meet_link             VARCHAR(300),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Один активный слот = одна запись
CREATE UNIQUE INDEX bookings_slot_unique
  ON bookings (master_id, date, time)
  WHERE status = 'upcoming';

CREATE INDEX ON bookings (master_id, tg_user_id);
CREATE INDEX ON bookings (master_id, date, status);
```

---

### Таблица `blocked_slots`

Мастер блокирует конкретные дни или слоты — отпуск, болезнь, личное.

```sql
CREATE TABLE blocked_slots (
  id          SERIAL PRIMARY KEY,
  master_id   INT         NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  date        DATE        NOT NULL,
  time        VARCHAR(5),             -- NULL = весь день заблокирован
  reason      VARCHAR(200),           -- только мастеру, клиент не видит
  UNIQUE (master_id, date, time)
);
```

---

## 2. API (клиентская часть — Mini App)

Все запросы от Mini App идут с заголовком:
```
X-Telegram-Init-Data: <raw initData string>
```
Бэкенд верифицирует HMAC-SHA256 и извлекает `user.id` и `start_param` (= master_id).

---

### `GET /api/master/:masterId`

Возвращает всё для первой загрузки Mini App.

**Ответ:**
```json
{
  "specialist": {
    "name": "Иван Иванов",
    "firstName": "Иван",
    "initials": "ИИ",
    "title": "Массажист",
    "about": "...",
    "photo_url": "https://...",
    "rating": 4.9,
    "clients": 150,
    "sessions": 400,
    "nextSlot": "сегодня 18:00",
    "contactHandle": "ivan_massage",
    "botHandle": "ivan_massage_bot"
  },
  "services": [...],
  "reviews": [...],
  "schedule": {
    "availableWeekdays": [1,2,3,4,5,6],
    "timeSlots": ["10:00", "11:00", ...]
  }
}
```

---

### `GET /api/master/:masterId/slots?date=YYYY-MM-DD`

Возвращает какие слоты свободны в конкретную дату.

**Ответ:**
```json
{
  "date": "2026-05-15",
  "slots": [
    { "time": "10:00", "available": true },
    { "time": "11:00", "available": false },
    { "time": "13:00", "available": true }
  ]
}
```

---

### `POST /api/master/:masterId/bookings`

Создать запись. Требует initData в заголовке.

**Тело:**
```json
{
  "serviceId": 42,
  "date": "2026-05-15",
  "time": "10:00",
  "clientName": "Анна",
  "clientRequest": "Хочу снять напряжение в спине"
}
```

**Ответ 201:**
```json
{
  "bookingId": 123,
  "paymentRequired": true,
  "invoiceUrl": "...",   // если платная услуга — Telegram Invoice URL
  "message": "Запись создана"
}
```

**Логика:**
1. Проверить initData
2. Проверить что слот свободен (иначе 409 Conflict)
3. Создать booking со статусом `pending` (платная) или `upcoming` (бесплатная)
4. Для платной — создать инвойс через Telegram Payments, вернуть URL
5. Уведомить мастера через его бота: «Новая запись от Анны»

---

### `GET /api/master/:masterId/bookings`

Записи текущего пользователя (по `tg_user_id` из initData).

**Ответ:**
```json
{
  "bookings": [
    {
      "id": 123,
      "service": "Индивидуальная сессия",
      "duration": "60 мин",
      "date": "2026-05-15",
      "time": "10:00",
      "status": "upcoming",
      "paymentStatus": "paid"
    }
  ]
}
```

---

### `PATCH /api/master/:masterId/bookings/:id/cancel`

Отменить запись. Только своя запись (проверка по `tg_user_id`).

**Ответ 200:**
```json
{ "status": "cancelled" }
```

---

### `POST /api/master/:masterId/webhook/payment`

Telegram отправляет `pre_checkout_query` и `successful_payment`.

**pre_checkout_query:**
```
→ Ответить answerPreCheckoutQuery(ok: true) в течение 10 сек
```

**successful_payment:**
```
→ Обновить booking.payment_status = 'paid'
→ Обновить booking.status = 'upcoming'
→ Обновить booking.tg_payment_charge_id
→ Отправить клиенту: «Оплата прошла, ждём вас!»
→ Уведомить мастера: «Оплата получена от Анны»
```

---

## 3. Webhook-роутинг для мультимастеров

Каждый бот мастера ставит свой webhook на уникальный URL:

```
https://api.platform.com/bot/:masterBotToken/webhook
```

**Пример кода роутера:**
```js
app.post('/bot/:token/webhook', async (req, res) => {
  const master = await db.masters.findOne({ botToken: req.params.token });
  if (!master) return res.sendStatus(404);
  
  await handleUpdate(master, req.body);
  res.sendStatus(200);
});
```

Все команды от клиентов и мастера обрабатываются в `handleUpdate(master, update)`.

---

## 4. Регистрация мастера

Мастер сам регистрируется — через бот платформы (один общий бот для онбординга).

### Шаги онбординга

**Шаг 1 — Токен**
```
Мастер → /start → «Привет! Чтобы создать своё приложение, пришли токен бота из @BotFather»
Мастер → токен бота
Платформа:
  1. Проверить токен через getMe
  2. Создать запись в masters
  3. Поставить webhook: setWebhook(url=api.platform/bot/{token}/webhook)
  4. Ответить: «Отлично! Теперь настроим профиль»
```

**Шаг 2 — Профиль**
Серия вопросов через бота (ReplyKeyboardMarkup или просто текст):
- Как вас зовут? → `masters.name`
- Ваша специализация? → `masters.title`
- Ссылка на фото (прямой URL)? → `masters.photo_url`
- Расскажите о себе (2-3 абзаца)? → `masters.about`

**Шаг 3 — Услуги**
- Назовите первую услугу: `{название} {длительность} {цена}`
  Пример: «Массаж 60 мин 3000»
- Добавить ещё? → повтор
- Хватит → переход к расписанию

**Шаг 4 — Расписание**
- В какие дни принимаете? (Пн–Пт / Пн–Сб / Все)
- В какое время? (вводит список: 10:00 12:00 15:00 18:00)

**Шаг 5 — Готово**
```
Платформа:
  1. setChatMenuButton → кнопка «ЗАПИСАТЬСЯ» → https://platform.com/app/{master_id}
  2. setMyDescription / setMyCommands для бота мастера
  3. Отправить мастеру:
     «Готово! Ссылка на ваше приложение: t.me/your_bot
      Ссылка для поделиться: https://platform.com/app/123
      Отправьте её своим клиентам.»
```

---

## 5. Команды мастера в своём боте

Бот мастера — это его CRM. Распознаём, что это мастер, по `tg_user_id == master.admin_tg_user_id`.

| Команда | Что делает |
|---|---|
| `/dashboard` | Показывает: записей на сегодня N, всего активных M |
| `/bookings` | Список предстоящих записей с именами и временем |
| `/block 2026-05-15` | Заблокировать весь день |
| `/block 2026-05-15 10:00` | Заблокировать конкретный слот |
| `/addreview` | Запускает диалог добавления отзыва |
| `/editprofile` | Запускает диалог редактирования профиля |
| `/link` | Отправляет ссылку на приложение (поделиться) |
| `/stats` | Статистика: клиентов за месяц, доход (если есть оплата) |

---

## 6. Уведомления клиенту

Все уведомления идут от бота мастера (не от платформы) — клиент видит «Бот психолога», «Бот массажиста» и т.д.

| Событие | Сообщение |
|---|---|
| Запись создана | «Запись подтверждена! [дата и время], [услуга]. Ссылка на звонок придёт за час.» |
| Оплата получена | «Оплата прошла ✓ Ждём вас [дата]!» |
| Напоминание за 24 ч | «Напоминаем: завтра в [время] сессия с [имя мастера]» |
| Напоминание за 1 ч | «Через час начинается ваша сессия. [meet_link]» |
| Отмена | «Ваша запись на [дата] отменена.» |

---

## 7. Frontend — изменения в Mini App

Mini App нужно адаптировать под мультимастера. Текущий `data.js` заменяется API-запросом.

### Как Mini App узнаёт, чьё это приложение

Два варианта (используем оба как fallback):

1. **`start_param` в initData** — мастер делится ссылкой `t.me/bot?start=app_{master_id}`, Mini App читает `tg.initDataUnsafe.start_param`
2. **URL параметр** — `https://platform.com/app?master=123`

### Что меняется в app.js

**Было:**
```js
// Данные из data.js (статика)
const DATA = { specialist: {...}, services: [...] };
```

**Станет:**
```js
async function loadMasterData(masterId) {
  const res = await fetch(`/api/master/${masterId}`, {
    headers: { 'X-Telegram-Init-Data': tg.initData }
  });
  return res.json();
}
```

### Что показывает App если фото есть

Текущие инициалы (ЕЧ) заменяются на `<img>` если есть `photo_url`:
```js
// В renderHome(), renderProfile():
if (s.photo_url) {
  avatarEl.innerHTML = `<img src="${s.photo_url}" alt="${s.initials}">`;
} else {
  avatarEl.textContent = s.initials;
}
```

---

## 8. Telegram Payments — полный поток

Каждый мастер подключает свой платёжный провайдер в @BotFather → Payments.

```
Клиент нажимает «Оплатить» в Mini App
      ↓
POST /api/master/:id/bookings → создаёт booking(status=pending)
      ↓
Backend → sendInvoice(chat_id, title, prices, payload="booking:{id}")
      ↓
Telegram показывает экран оплаты (YooKassa/Stripe)
      ↓
Telegram → pre_checkout_query → backend отвечает ok:true
      ↓
Telegram → successful_payment → backend:
  - booking.status = 'upcoming'
  - booking.payment_status = 'paid'
  - sendMessage клиенту: подтверждение
  - sendMessage мастеру: уведомление
```

---

## 9. Безопасность

### Верификация initData

```js
function verifyInitData(initDataRaw, botToken) {
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  params.delete('hash');
  
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  
  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString).digest('hex');
  
  return hash === expectedHash;
}
```

Каждый API-запрос проходит через этот middleware. `botToken` берётся из таблицы `masters` по `masterId` из URL.

### Изоляция данных

Каждый SQL-запрос содержит `WHERE master_id = $1`. Клиент никогда не может получить данные другого мастера — даже если знает чужой `master_id`.

---

## 10. Tech Stack

| Слой | Технология | Почему |
|---|---|---|
| Backend | Node.js + Express | Один язык с фронтом, большая экосистема |
| База данных | PostgreSQL | ACID, JSONB для education/includes |
| ORM | node-postgres (pg) | Без абстракций, прямой SQL |
| Хостинг | Railway | Free PostgreSQL + Node.js, один клик |
| Планировщик | node-cron | Напоминания в 9:00 и за 1 час до сессии |
| Токены в .env | dotenv | Разные .env на dev/prod |

---

## 11. Стадии разработки

### Стадия 1 — Один мастер работает (2–3 дня)
- [ ] Таблицы: masters, services, bookings, schedule
- [ ] API: GET /master/:id, GET /slots, POST /bookings, GET /bookings/my
- [ ] Webhook: принимает обновления, уведомляет мастера о новой записи
- [ ] Mini App: заменить data.js на fetch из API
- [ ] Деплой на Railway

### Стадия 2 — Мастер управляет через бота (1–2 дня)
- [ ] Команды: /dashboard, /bookings, /block, /link
- [ ] Blocked_slots API
- [ ] Фото-аватар в Mini App

### Стадия 3 — Онбординг нового мастера (2–3 дня)
- [ ] Платформенный бот (/register)
- [ ] Диалог заполнения профиля, услуг, расписания
- [ ] Авто-настройка webhook + MenuButton для нового бота

### Стадия 4 — Оплата (2–3 дня)
- [ ] Telegram Payments: sendInvoice, pre_checkout_query, successful_payment
- [ ] Обновление статусов в bookings
- [ ] Уведомления об оплате

### Стадия 5 — Уведомления и напоминания (1 день)
- [ ] node-cron: проверка записей каждые 30 мин
- [ ] Отправка напоминаний за 24 ч и за 1 ч
- [ ] Добавление meet_link вручную через команду /meet 123 https://...

---

## 12. Переменные окружения

```env
# Платформенный бот (для онбординга мастеров)
PLATFORM_BOT_TOKEN=...
PLATFORM_BOT_SECRET=...   # для верификации webhook

# База данных
DATABASE_URL=postgresql://...

# Базовый URL платформы
BASE_URL=https://api.platform.com
MINI_APP_URL=https://platform.com/app

# Опционально
LOG_LEVEL=info
```

Токены ботов мастеров хранятся в таблице `masters.bot_token`, а не в .env.

---

## 13. Что остаётся на клиенте (не переносится)

| Что | Почему оставляем |
|---|---|
| Тест GAD-7 (7 вопросов) | Чистая клиентская логика, нет смысла серверить |
| Квиз онбординга | Тоже клиентский, результат — рекомендация услуги |
| Анимации и переходы | CSS/JS, не нужен сервер |
| localStorage для welcomeDone, offerShown | Разовые флаги, не критичны для бизнеса |
