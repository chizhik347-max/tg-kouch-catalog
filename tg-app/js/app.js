/* app.js — Главная логика приложения.
   Управляет навигацией, состоянием, рендерингом экранов.
   Все переходы — через App.navigate() и App.back(). */

const App = (() => {

  /* ── Состояние приложения ──────────────────────────────────── */
  const state = {
    currentScreen: 'splash',
    history: [],           // стек экранов для Back
    quizStep: 0,
    quizAnswers: [],
    recommendedServiceId: null, // устанавливается после квиза
    selectedService: null,
    calYear: null,
    calMonth: null,
    selectedDate: null,    // строка 'YYYY-MM-DD'
    selectedTime: null,
    consentGiven: false,
    bookings: [],          // записи в памяти
    activeTab: 'upcoming', // вкладка "Мои записи"
    tgUser: null,
  };

  /* ── Telegram SDK ─────────────────────────────────────────── */
  const tg = window.Telegram?.WebApp;

  function initTelegram() {
    if (!tg) return;
    tg.ready();
    tg.expand();
    if (tg.initDataUnsafe?.user) {
      state.tgUser = tg.initDataUnsafe.user;
    }
    // Регистрируем обработчик Back ОДИН РАЗ — иначе каждый navigate стекал бы новый
    tg.BackButton.onClick(back);
  }

  /* ── Навигация ────────────────────────────────────────────── */
  const SCREEN_IDS = {
    splash:          'screen-splash',
    quiz:            'screen-quiz',
    home:            'screen-home',
    serviceDetail:   'screen-service-detail',
    datePicker:      'screen-date-picker',
    bookingConfirm:  'screen-booking-confirm',
    payment:         'screen-payment',
    success:         'screen-success',
    myBookings:      'screen-my-bookings',
    profile:         'screen-profile',
  };

  function getEl(screenKey) {
    return document.getElementById(SCREEN_IDS[screenKey]);
  }

  function navigate(to, skipHistory = false) {
    const from = state.currentScreen;
    if (from === to) return;

    const fromEl = getEl(from);
    const toEl   = getEl(to);

    if (!toEl) { console.warn('Экран не найден:', to); return; }

    // Инициализируем целевой экран перед показом
    renderScreen(to);

    // Сохраняем историю
    if (!skipHistory && from !== 'splash') {
      state.history.push(from);
    }

    // Анимация: текущий уходит влево, новый приходит справа
    fromEl?.classList.remove('screen--active');
    fromEl?.classList.add('screen--behind');

    toEl.classList.add('screen--active');
    toEl.style.transform = 'translateX(100%)';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toEl.style.transform = '';
      });
    });

    // Убираем класс behind после анимации
    setTimeout(() => {
      fromEl?.classList.remove('screen--behind');
    }, 280);

    state.currentScreen = to;

    // Только показываем/скрываем — обработчик зарегистрирован один раз в initTelegram
    if (tg) {
      if (state.history.length > 0) tg.BackButton.show();
      else tg.BackButton.hide();
    }
    syncTabBar();
  }

  function back() {
    if (state.history.length === 0) {
      tg?.close();
      return;
    }
    const prev = state.history.pop();
    const from = state.currentScreen;

    renderScreen(prev);

    const fromEl = getEl(from);
    const prevEl = getEl(prev);

    fromEl?.classList.remove('screen--active');

    prevEl?.classList.remove('screen--behind');
    prevEl?.classList.add('screen--active');

    // Анимация: текущий уходит вправо
    fromEl.style.transition = 'none';
    fromEl.style.transform  = 'translateX(0)';
    requestAnimationFrame(() => {
      fromEl.style.transition = '';
      fromEl.style.transform  = 'translateX(100%)';
      setTimeout(() => { fromEl.style.transform = ''; }, 280);
    });

    state.currentScreen = prev;

    if (tg) {
      if (state.history.length > 0) tg.BackButton.show();
      else tg.BackButton.hide();
    }
    syncTabBar();
  } // end back()

  /* ── Рендеринг экранов ────────────────────────────────────── */
  function renderScreen(key) {
    switch (key) {
      case 'home':          renderHome();          break;
      case 'quiz':          renderQuiz();          break;
      case 'serviceDetail': renderServiceDetail(); break;
      case 'datePicker':    renderDatePicker();    break;
      case 'bookingConfirm':renderBookingConfirm();break;
      case 'success':       renderSuccess();       break;
      case 'myBookings':    renderMyBookings();    break;
      case 'profile':       renderProfile();       break;
      // payment рендерится отдельно в navigatePublic после перехода
    }
  }

  /* ── ГЛАВНАЯ ──────────────────────────────────────────────── */
  function renderHome() {
    const s = DATA.specialist;
    set('home-name', s.name);
    set('home-spec-title', s.title);
    set('home-rating', s.rating.toFixed(1));
    set('home-clients', `${s.clients}+ клиентов`);
    set('home-slot-text', `Ближайший слот: ${s.nextSlot}`);

    // Услуги — рендерим каждый раз, чтобы учитывать рекомендацию после квиза
    const list = document.getElementById('home-services');
    if (list) {
      const recId = state.recommendedServiceId;
      list.innerHTML = DATA.services.map(svc => {
        const isRec = recId && svc.id === recId;
        const badge = isRec
          ? `<span class="service-card__badge service-card__badge--green">Рекомендуем для вас</span>`
          : (svc.badge ? `<span class="service-card__badge">${svc.badge}</span>` : '');
        return `
          <div class="service-card ${svc.price === 0 ? 'service-card--free' : ''} ${isRec ? 'service-card--rec' : ''}"
               onclick="App.selectService('${svc.id}')">
            <div class="service-card__icon">${svc.icon}</div>
            <div class="service-card__info">
              <div class="service-card__name">${svc.name}</div>
              <div class="service-card__meta">${svc.duration} · ${svc.format}</div>
              ${badge}
            </div>
            <div class="service-card__price">${svc.priceLabel}</div>
          </div>`;
      }).join('');
    }

    // Отзывы — статичные, рендерим один раз
    const rev = document.getElementById('home-reviews');
    if (rev && !rev.dataset.rendered) {
      rev.dataset.rendered = '1';
      rev.innerHTML = DATA.reviews.map(r => reviewCard(r)).join('');
    }
  }

  /* ── КВИЗ ─────────────────────────────────────────────────── */
  function renderQuiz() {
    const step = state.quizStep;
    const q    = DATA.quiz[step];
    const pct  = Math.round(((step + 1) / DATA.quiz.length) * 100);

    document.getElementById('quiz-progress-fill').style.width = pct + '%';
    set('quiz-step-label', `Шаг ${step + 1} из ${DATA.quiz.length}`);
    set('quiz-question', q.question);

    // Показываем Back только начиная со 2-го шага
    const backBtn = document.getElementById('quiz-back-btn');
    if (backBtn) backBtn.style.visibility = step > 0 ? 'visible' : 'hidden';

    const opts = document.getElementById('quiz-options');
    opts.innerHTML = q.options.map(opt => `
      <div class="chip" onclick="App.quizSelect(this, '${opt.replace(/'/g, "\\'")}')">${opt}</div>
    `).join('');

    const btn = document.getElementById('quiz-next-btn');
    btn.disabled = true;
    btn.textContent = step < DATA.quiz.length - 1 ? 'Далее' : 'Перейти к услугам';
    btn.onclick = quizNext;
  }

  function quizBack() {
    if (state.quizStep > 0) {
      state.quizStep--;
      renderQuiz();
    }
  }

  function quizSelect(el, value) {
    // Снимаем выделение, выделяем выбранный
    el.closest('.quiz__options').querySelectorAll('.chip').forEach(c => c.classList.remove('chip--active'));
    el.classList.add('chip--active');
    state.quizAnswers[state.quizStep] = value;
    document.getElementById('quiz-next-btn').disabled = false;
    haptic('selection');
  }

  function quizNext() {
    if (state.quizStep < DATA.quiz.length - 1) {
      state.quizStep++;
      renderQuiz();
    } else {
      localStorage.setItem('quizDone', '1');
      // Определяем рекомендацию по первому ответу (тема запроса)
      const topicMap = {
        'Тревога и стресс':    'individual',
        'Отношения':           'individual',
        'Работа и выгорание':  'package',
        'Самооценка':          'individual',
        'Жизненный кризис':    'package',
        'Просто поговорить':   'trial',
      };
      state.recommendedServiceId = topicMap[state.quizAnswers[0]] || 'individual';
      localStorage.setItem('recommendedServiceId', state.recommendedServiceId);
      navigate('home');
    }
  }

  /* ── ДЕТАЛИ УСЛУГИ ────────────────────────────────────────── */
  function renderServiceDetail() {
    const svc = state.selectedService;
    if (!svc) return;
    const s = DATA.specialist;

    set('detail-header-title', svc.name);
    set('detail-icon', svc.icon);
    set('detail-name', svc.name);
    set('detail-meta', `${svc.duration} · ${svc.format}`);

    const priceEl = document.getElementById('detail-price');
    priceEl.textContent = svc.priceLabel;
    priceEl.className   = 'service-detail__price' + (svc.price === 0 ? ' service-detail__price--free' : '');

    set('detail-description', svc.description);

    document.getElementById('detail-includes').innerHTML = svc.includes
      .map(i => `<div class="includes-item"><span class="includes-item__check">✓</span><span>${i}</span></div>`)
      .join('');

    document.getElementById('detail-for-whom').innerHTML = svc.forWhom
      .map(f => `<span class="chip chip--tag">${f}</span>`)
      .join('');

    set('detail-spec-name', s.name);
    set('detail-spec-title', s.title);

    const rev = DATA.reviews[0];
    document.getElementById('detail-review').innerHTML = reviewCard(rev);
  }

  /* ── ВЫБОР ДАТЫ/ВРЕМЕНИ ───────────────────────────────────── */
  function renderDatePicker() {
    const svc = state.selectedService;
    if (svc) {
      set('picker-context', `${svc.name} · ${svc.duration} · ${svc.priceLabel}`);
    }
    // Инициализируем дату просмотра если не задана
    if (!state.calYear) {
      const now = new Date();
      state.calYear  = now.getFullYear();
      state.calMonth = now.getMonth(); // 0-based
    }
    renderCalendar();
    renderSlots();
    document.getElementById('picker-next-btn').disabled = !(state.selectedDate && state.selectedTime);
  }

  function renderCalendar() {
    const year  = state.calYear;
    const month = state.calMonth;
    const today = new Date();
    today.setHours(0,0,0,0);

    // Название месяца
    const monthName = new Date(year, month, 1).toLocaleString('ru', { month: 'long', year: 'numeric' });
    set('cal-month-label', monthName[0].toUpperCase() + monthName.slice(1));

    // Блокируем «‹» если уже текущий месяц
    const now = new Date();
    const prevBtn = document.getElementById('cal-prev');
    if (prevBtn) {
      const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
      prevBtn.disabled = isCurrentMonth;
      prevBtn.style.opacity = isCurrentMonth ? '0.25' : '1';
      prevBtn.style.cursor  = isCurrentMonth ? 'default' : 'pointer';
    }

    // Дни недели
    const weekDays = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    document.getElementById('cal-weekdays').innerHTML =
      weekDays.map(d => `<div class="calendar__weekday">${d}</div>`).join('');

    // Первый день месяца (0=Вс, 1=Пн…)
    let firstDay = new Date(year, month, 1).getDay();
    firstDay = firstDay === 0 ? 6 : firstDay - 1; // приводим к Пн=0

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let html = '';

    // Пустые ячейки до первого дня
    for (let i = 0; i < firstDay; i++) {
      html += '<button class="cal-day cal-day--empty" disabled></button>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const date   = new Date(year, month, d);
      const dow    = date.getDay(); // 0=Вс
      const isPast = date < today;
      const isAvail = DATA.availableWeekdays.includes(dow) && !isPast;
      const dateStr = formatDateStr(year, month, d);
      const isToday  = date.getTime() === today.getTime();
      const isSelected = dateStr === state.selectedDate;

      let cls = 'cal-day';
      if (isToday)    cls += ' cal-day--today';
      if (!isAvail)   cls += ' cal-day--unavailable';
      if (isAvail)    cls += ' cal-day--available';
      if (isSelected) cls += ' cal-day--selected';

      html += `<button class="${cls}" onclick="App.calSelectDay('${dateStr}')">${d}</button>`;
    }

    document.getElementById('cal-days').innerHTML = html;
  }

  function renderSlots() {
    const section = document.getElementById('slots-section');

    if (!state.selectedDate) {
      section.innerHTML = '<div class="no-slots" style="color:var(--hint);padding:16px;font-size:14px">Выберите дату ↑</div>';
      return;
    }

    const slots = DATA.timeSlots;
    const morning  = slots.filter(t => parseInt(t) < 12);
    const day      = slots.filter(t => parseInt(t) >= 12 && parseInt(t) < 17);
    const evening  = slots.filter(t => parseInt(t) >= 17);

    function renderGroup(label, group) {
      if (!group.length) return '';
      const btns = group.map(t => {
        const booked   = DATA.isSlotBooked(state.selectedDate, t);
        const selected = state.selectedTime === t;
        let cls = 'slot-btn';
        if (booked)   cls += ' slot-btn--booked';
        if (selected) cls += ' slot-btn--selected';
        return `<button class="${cls}" ${booked ? 'disabled' : ''} onclick="App.selectSlot('${t}')">${t}</button>`;
      }).join('');

      // Проверяем что есть хоть один доступный слот в группе
      const hasAvail = group.some(t => !DATA.isSlotBooked(state.selectedDate, t));
      if (!hasAvail) return '';

      return `<div class="slots-label">${label}</div><div class="slots-grid">${btns}</div>`;
    }

    const html = renderGroup('Утро', morning) + renderGroup('День', day) + renderGroup('Вечер', evening);

    if (!html) {
      section.innerHTML = `
        <div class="no-slots">
          На эту дату нет свободного времени.<br>
          <a class="no-slots__link" href="https://t.me/${DATA.specialist.contactHandle}" onclick="openTG(this)">
            Написать в чат →
          </a>
        </div>`;
    } else {
      section.innerHTML = html;
    }
  }

  function calSelectDay(dateStr) {
    state.selectedDate = dateStr;
    state.selectedTime = null; // сброс слота при смене дня
    document.getElementById('picker-next-btn').disabled = true;
    renderCalendar();
    renderSlots();
    haptic('impact');
    // Скроллим к слотам — они появляются ниже календаря и могут быть не видны
    setTimeout(() => {
      const body    = document.querySelector('#screen-date-picker .screen__body');
      const section = document.getElementById('slots-section');
      if (body && section) {
        body.scrollTo({ top: section.offsetTop - 8, behavior: 'smooth' });
      }
    }, 60);
  }

  function calPrevMonth() {
    const now = new Date();
    // Нельзя листать раньше текущего месяца
    if (state.calYear === now.getFullYear() && state.calMonth === now.getMonth()) return;
    state.calMonth--;
    if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
    state.selectedDate = null;
    state.selectedTime = null;
    document.getElementById('picker-next-btn').disabled = true;
    renderCalendar();
    renderSlots();
  }

  function calNextMonth() {
    state.calMonth++;
    if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
    state.selectedDate = null;
    state.selectedTime = null;
    document.getElementById('picker-next-btn').disabled = true;
    renderCalendar();
    renderSlots();
  }

  function selectSlot(time) {
    state.selectedTime = time;
    renderSlots(); // перерисовываем для нового выделения
    document.getElementById('picker-next-btn').disabled = false;
    haptic('selection');
  }

  /* ── ПОДТВЕРЖДЕНИЕ ЗАПИСИ ────────────────────────────────── */
  function renderBookingConfirm() {
    const svc  = state.selectedService;
    const date = state.selectedDate;
    const time = state.selectedTime;

    if (!svc || !date || !time) return;

    const dateLabel = formatDateLabel(date, time, svc.durationMin);

    document.getElementById('confirm-details').innerHTML = `
      <div class="confirm-row">
        <span class="confirm-row__icon">📅</span>
        <div><div class="confirm-row__label">Дата и время</div>
        <div class="confirm-row__value">${dateLabel}</div></div>
      </div>
      <div class="confirm-row">
        <span class="confirm-row__icon">💼</span>
        <div><div class="confirm-row__label">Услуга</div>
        <div class="confirm-row__value">${svc.name}, ${svc.duration}</div></div>
      </div>
      <div class="confirm-row">
        <span class="confirm-row__icon">🌐</span>
        <div><div class="confirm-row__label">Формат</div>
        <div class="confirm-row__value">${svc.format} — Telegram Video</div></div>
      </div>
    `;

    // Подставляем имя из Telegram
    const nameInput = document.getElementById('confirm-name');
    if (state.tgUser?.first_name && !nameInput.value) {
      nameInput.value = state.tgUser.first_name;
    }

    const priceLabel = svc.price === 0 ? 'Бесплатно' : svc.priceLabel;
    set('confirm-total-price', priceLabel);

    // Согласие уже сброшено в selectService — просто синхронизируем UI
    updateConsentUI();

    // Слушаем изменение поля имени
    nameInput.oninput = () => updatePayBtn();
  }

  function toggleConsent() {
    state.consentGiven = !state.consentGiven;
    updateConsentUI();
    haptic('selection');
  }

  function updateConsentUI() {
    const box = document.getElementById('consent-checkbox');
    if (state.consentGiven) {
      box.classList.add('consent-checkbox--checked');
      box.textContent = '✓';
    } else {
      box.classList.remove('consent-checkbox--checked');
      box.textContent = '';
    }
    updatePayBtn();
  }

  function updatePayBtn() {
    const name   = document.getElementById('confirm-name')?.value?.trim();
    const btn    = document.getElementById('confirm-pay-btn');
    if (!btn) return;
    btn.disabled = !(state.consentGiven && name);
    const svc = state.selectedService;
    if (svc) {
      btn.textContent = svc.price === 0
        ? 'Подтвердить запись'
        : `Оплатить ${svc.priceLabel}`;
    }
  }

  /* ── ОПЛАТА (симуляция) ───────────────────────────────────── */
  function renderPayment() {
    set('payment-text', 'Обрабатываем…');
    setTimeout(() => {
      saveBooking();
      // Сбрасываем стек флоу бронирования — назад вернёт на главную, не на платёж
      state.history = ['home'];
      navigate('success', true); // skipHistory=true: не пушим 'payment'
    }, 1800);
  }

  // Переход с экрана Успеха на Мои записи — не добавляет success в историю
  function goToMyBookingsFromSuccess() {
    state.history = ['home'];
    navigate('myBookings', true);
  }

  function saveBooking() {
    const svc = state.selectedService;
    state.bookings.unshift({
      id:       Date.now(),
      service:  svc.name,
      duration: svc.duration,
      date:     state.selectedDate,
      time:     state.selectedTime,
      price:    svc.priceLabel,
      status:   'upcoming',
    });
    persistBookings();
  }

  function persistBookings() {
    try { localStorage.setItem('bookings', JSON.stringify(state.bookings)); } catch(e) {}
  }

  function loadBookings() {
    try {
      const raw = localStorage.getItem('bookings');
      if (raw) state.bookings = JSON.parse(raw);
    } catch(e) {}
  }

  /* ── УСПЕХ ────────────────────────────────────────────────── */
  function renderSuccess() {
    const svc  = state.selectedService;
    const date = state.selectedDate;
    const time = state.selectedTime;

    const dateLabel = formatDateLabel(date, time, svc?.durationMin || 60);
    set('success-subtitle', dateLabel);

    document.getElementById('success-details').innerHTML = `
      <div class="confirm-row">
        <span class="confirm-row__icon">📅</span>
        <div><div class="confirm-row__label">Дата и время</div>
        <div class="confirm-row__value">${dateLabel}</div></div>
      </div>
      <div class="confirm-row">
        <span class="confirm-row__icon">💼</span>
        <div><div class="confirm-row__label">Услуга</div>
        <div class="confirm-row__value">${svc?.name || ''}</div></div>
      </div>
    `;

    // Апсейл — только для одиночной сессии
    const upsell = document.getElementById('success-upsell');
    if (upsell) {
      upsell.style.display = svc?.id === 'individual' ? 'block' : 'none';
    }
  }

  /* ── МОИ ЗАПИСИ ───────────────────────────────────────────── */
  function renderMyBookings() {
    renderBookingsList('upcoming');
    renderBookingsList('past');
  }

  function renderBookingsList(type) {
    const container = document.getElementById(`bookings-${type}`);
    if (!container) return;

    const items = state.bookings.filter(b => b.status === type);

    if (!items.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">${type === 'upcoming' ? '📅' : '🗂'}</div>
          <div class="empty-state__text">${type === 'upcoming' ? 'Нет предстоящих записей' : 'Завершённые сессии появятся здесь'}</div>
          ${type === 'upcoming' ? '<a class="empty-state__link" onclick="App.navigate(\'home\')">Записаться →</a>' : ''}
        </div>`;
      return;
    }

    container.innerHTML = items.map(b => {
      const dateLabel = formatDateLabel(b.date, b.time, 60);
      if (type === 'upcoming') {
        return `
          <div class="booking-card">
            <div class="booking-card__date">${dateLabel}</div>
            <div class="booking-card__service">${b.service} · ${b.duration}</div>
            <div class="booking-card__actions">
              <button class="booking-card__rebooking" onclick="App.rebookSession('${b.id}')">
                Записаться снова
              </button>
              <button class="booking-card__cancel" onclick="App.cancelBooking(${b.id})">
                Отменить
              </button>
            </div>
          </div>`;
      } else {
        return `
          <div class="booking-card">
            <div class="booking-card__date">${dateLabel}</div>
            <div class="booking-card__service">${b.service} · ${b.duration}</div>
            <div class="booking-card__actions">
              <button class="booking-card__rebooking" onclick="App.rebookSession('${b.id}')">
                Записаться снова
              </button>
            </div>
          </div>`;
      }
    }).join('');
  }

  function switchTab(type) {
    state.activeTab = type;
    document.getElementById('tab-upcoming').classList.toggle('tab-btn--active', type === 'upcoming');
    document.getElementById('tab-past').classList.toggle('tab-btn--active', type === 'past');
    document.getElementById('bookings-upcoming').style.display = type === 'upcoming' ? '' : 'none';
    document.getElementById('bookings-past').style.display     = type === 'past'     ? '' : 'none';
  }

  function cancelBooking(id) {
    const msg = 'Отменить запись?\n\nБесплатная отмена за 24 часа до сессии.';
    if (tg) {
      tg.showConfirm(msg, (ok) => {
        if (ok) doCancel(id);
      });
    } else if (confirm(msg)) {
      doCancel(id);
    }
  }

  function doCancel(id) {
    const b = state.bookings.find(b => b.id === id);
    if (b) { b.status = 'past'; }
    persistBookings();
    renderMyBookings();
    haptic('notification');
  }

  function rebookSession(id) {
    const b = state.bookings.find(b => String(b.id) === String(id));
    if (b) {
      const svc = DATA.services.find(s => s.name === b.service);
      if (svc) state.selectedService = svc;
    }
    // Сброс выбранной даты/времени
    state.selectedDate = null;
    state.selectedTime = null;
    state.calYear  = null;
    state.calMonth = null;
    navigate('datePicker');
  }

  /* ── ПРОФИЛЬ СПЕЦИАЛИСТА ──────────────────────────────────── */
  function renderProfile() {
    const s = DATA.specialist;
    set('profile-name', s.name);
    set('profile-title', s.title);
    set('profile-rating', `${s.rating.toFixed(1)} · ${s.sessions}+ сессий`);
    set('profile-clients', `${s.clients}+`);
    set('profile-sessions', `${s.sessions}+`);
    set('profile-about', s.about);

    document.getElementById('profile-specs').innerHTML = s.specializations
      .map(sp => `<span class="chip" style="cursor:default">${sp}</span>`)
      .join('');

    document.getElementById('profile-edu').innerHTML = s.education
      .map(e => `<div class="edu-item"><span class="edu-item__icon">${e.icon}</span><span>${e.text}</span></div>`)
      .join('');

    document.getElementById('profile-reviews').innerHTML = DATA.reviews
      .map(r => reviewCard(r))
      .join('');
  }

  /* ── ТАББАР ГЛАВНОЙ ───────────────────────────────────────── */

  // Вызывается после каждого navigate/back — держит подсветку актуальной
  function syncTabBar() {
    const s = state.currentScreen;
    document.getElementById('nav-services')?.classList.toggle('bottom-nav__btn--active', s === 'home');
    document.getElementById('nav-bookings')?.classList.toggle('bottom-nav__btn--active', s === 'myBookings');
    document.getElementById('nav-profile')?.classList.toggle('bottom-nav__btn--active', s === 'profile');
  }

  function goTab(tab) {
    ['services','bookings','profile'].forEach(t => {
      document.getElementById(`nav-${t}`)?.classList.toggle('bottom-nav__btn--active', t === tab);
    });
    if (tab === 'services') {
      // Уже на главной — просто скроллим вверх
      document.querySelector('#screen-home .screen__body')?.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tab === 'bookings') {
      navigate('myBookings');
    } else if (tab === 'profile') {
      navigate('profile');
    }
  }

  /* ── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ──────────────────────────────── */

  function set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function reviewCard(r) {
    const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    return `
      <div class="review-card">
        <div class="review-card__header">
          <div class="avatar avatar--sm" style="font-size:12px">${r.name[0]}</div>
          <div class="review-card__name">${r.name}</div>
          <div class="review-card__date">${r.date}</div>
        </div>
        <div class="stars">${stars}</div>
        <div class="review-card__text" style="margin-top:6px">${r.text}</div>
      </div>`;
  }

  function formatDateStr(year, month, day) {
    return `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  function formatDateLabel(dateStr, time, durationMin) {
    if (!dateStr || !time) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const weekday = date.toLocaleString('ru', { weekday: 'short' });
    const dayMonth = date.toLocaleString('ru', { day: 'numeric', month: 'long' });
    // Вычисляем время окончания
    const [h, min] = time.split(':').map(Number);
    const endDate = new Date(y, m - 1, d, h, min + (durationMin || 60));
    const endTime = `${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;
    return `${weekday}, ${dayMonth} · ${time} — ${endTime}`;
  }

  function haptic(type) {
    if (!tg?.HapticFeedback) return;
    if (type === 'selection')    tg.HapticFeedback.selectionChanged();
    if (type === 'impact')       tg.HapticFeedback.impactOccurred('light');
    if (type === 'notification') tg.HapticFeedback.notificationOccurred('success');
  }

  function addToCalendar() {
    const date = state.selectedDate;
    const time = state.selectedTime;
    if (!date || !time) return;
    const [y, m, d] = date.split('-').map(Number);
    const [h, min]  = time.split(':').map(Number);
    const start       = new Date(y, m - 1, d, h, min);
    const durationMin = state.selectedService?.durationMin || 60;
    const end         = new Date(start.getTime() + durationMin * 60 * 1000);

    const fmt = dt => dt.toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
    const url = `https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent('Сессия с Еленой Чижик')}&dates=${fmt(start)}/${fmt(end)}`;

    if (tg) tg.openLink(url);
    else    window.open(url, '_blank');
  }

  function showUpsellInfo() {
    const msg = 'Пакет 5 сессий — 12 000 ₽\nЭкономия 3 000 ₽ (15%)\n\nНапишите в чат для оформления пакета.';
    if (tg) tg.showAlert(msg);
    else    alert(msg);
  }

  function selectService(id) {
    state.selectedService = DATA.services.find(s => s.id === id);
    // Сбрасываем согласие при выборе НОВОЙ услуги, а не при каждом рендере формы
    state.consentGiven = false;
    navigate('serviceDetail');
  }

  function openTG(el) {
    event?.preventDefault();
    if (tg) tg.openTelegramLink(el.href);
    else    window.open(el.href, '_blank');
  }

  /* ── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────── */
  function init() {
    initTelegram();

    if (tg?.colorScheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    // Восстанавливаем данные из localStorage
    loadBookings();
    state.recommendedServiceId = localStorage.getItem('recommendedServiceId');

    const quizDone = localStorage.getItem('quizDone');
    // Возвращающимся пользователям — короткий сплэш (600 мс вместо 1400)
    setTimeout(() => {
      navigate(quizDone ? 'home' : 'quiz', true);
    }, quizDone ? 600 : 1400);
  }

  // Перехват navigate('payment') — нужна симуляция
  const _navigate = navigate;
  function navigatePublic(to) {
    if (to === 'payment') {
      _navigate('payment', false);
      renderPayment(); // запускаем симуляцию после перехода
    } else {
      _navigate(to, false);
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  /* ── Публичный API ────────────────────────────────────────── */
  return {
    navigate:      navigatePublic,
    back,
    selectService,
    quizSelect,
    quizBack,
    calSelectDay,
    calPrevMonth,
    calNextMonth,
    selectSlot,
    toggleConsent,
    switchTab,
    cancelBooking,
    rebookSession,
    goTab,
    addToCalendar,
    showUpsellInfo,
    goToMyBookingsFromSuccess,
  };

})();
