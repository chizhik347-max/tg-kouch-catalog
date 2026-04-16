# CLAUDE.md — Карта проекта: Telegram Mini App психолога

## Структура файлов

```
tg-kouch-catalog/
  research.md          Исследование рынка: 5 примеров + экспертная оценка
  brief.md             Пошаговый план: экраны, элементы, переходы, что не в v1
  CLAUDE.md            Этот файл — карта проекта
  tg-app/
    index.html         Точка входа. Содержит HTML-разметку всех 9 экранов.
    css/
      styles.css       Все стили. Цвета через --tg-theme-* переменные.
    js/
      data.js          ТОЛЬКО ДАННЫЕ: специалист, услуги, отзывы, квиз.
      app.js           Вся логика: навигация, рендеринг, состояние.
```

---

## Где менять контент

| Что изменить | Файл | Что редактировать |
|---|---|---|
| Имя, специализация, биография | `js/data.js` | `DATA.specialist` |
| Услуги (название, цена, описание) | `js/data.js` | `DATA.services[]` |
| Отзывы | `js/data.js` | `DATA.reviews[]` |
| Вопросы квиза | `js/data.js` | `DATA.quiz[]` |
| Доступные дни | `js/data.js` | `DATA.availableWeekdays` |
| Временные слоты | `js/data.js` | `DATA.timeSlots` |
| Username специалиста | `js/data.js` | `DATA.specialist.contactHandle` |
| Акцентный цвет | `css/styles.css` | `--accent` в `:root` |

---

## Экраны и навигация

```
splash → (квиз если первый запуск) → home
home → serviceDetail → datePicker → bookingConfirm → payment → success → myBookings
home → profile
home (таббар) → myBookings
```

| Экран | HTML id | Рендер-функция в app.js |
|---|---|---|
| Сплэш | `screen-splash` | — (статичный) |
| Квиз | `screen-quiz` | `renderQuiz()` |
| Главная | `screen-home` | `renderHome()` |
| Детали услуги | `screen-service-detail` | `renderServiceDetail()` |
| Выбор даты/времени | `screen-date-picker` | `renderDatePicker()` |
| Подтверждение | `screen-booking-confirm` | `renderBookingConfirm()` |
| Оплата | `screen-payment` | `renderPayment()` (симуляция) |
| Успех | `screen-success` | `renderSuccess()` |
| Мои записи | `screen-my-bookings` | `renderMyBookings()` |
| Профиль | `screen-profile` | `renderProfile()` |

---

## Как работает навигация

```js
App.navigate('serviceDetail')  // переход вперёд
App.back()                     // назад (по стеку history)
```

Переходы — CSS `transform: translateX`. Новый экран приходит справа, старый уходит на −30% влево. Стек хранится в `state.history[]`.

При работе внутри реального Telegram:
- `BackButton` SDK управляется автоматически
- `expand()` вызывается при старте
- Haptic feedback на выборах и подтверждениях

---

## Состояние приложения (state в app.js)

```js
state.selectedService   // выбранная услуга (объект из DATA.services)
state.selectedDate      // строка 'YYYY-MM-DD'
state.selectedTime      // строка 'HH:MM'
state.bookings[]        // записи в памяти (сбрасываются при перезагрузке)
state.consentGiven      // согласие на обработку данных
state.quizAnswers[]     // ответы квиза
```

---

## Тестирование

**В браузере:**
- Открыть `tg-app/index.html` напрямую (через Live Server или file://)
- SDK подключён, но `window.Telegram.WebApp` будет undefined — fallback-поведение активно
- Тёмная тема: браузерные настройки → prefers-color-scheme

**В Telegram:**
1. Создать бота через @BotFather
2. Задеплоить папку `tg-app/` на хостинг с HTTPS
3. В BotFather: `/newapp` → указать URL

---

## Что не реализовано в v1 (перенесено в v2)

- Покупка пакета (кнопка показывается, но ведёт в чат)
- Реальная оплата (Telegram Payments API — нужен backend)
- Перенос/reschedule записи  
- Видео-визитка специалиста
- Push-напоминания (нужен Telegram Bot backend)
- Несколько специалистов
- Полный список отзывов
- Верификация initData на сервере

---

## Следующие шаги для продакшна

1. Создать backend (Node.js / Python) для хранения записей и верификации initData
2. Подключить Telegram Payments + YooKassa
3. Настроить бота для отправки напоминаний за 24 ч и 1 ч до сессии
4. Заменить `DATA.isSlotBooked()` на реальное расписание из базы
5. Добавить реальное фото специалиста вместо аватара с инициалами
