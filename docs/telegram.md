# Telegram — подготовка бета-выпуска / Upcoming beta

**Статус:** реализация находится в [PR исходников](https://github.com/Olegu621/xlamBOT-source/pull/3), доступном участникам закрытого репозитория. Текущая публичная сборка ещё не содержит Telegram. Этот документ описывает подготовленные функции и требования к выпуску; установка текущего EXE не включает их автоматически.

## Подготовленные возможности

- Необязательное подключение при первом запуске в консоли. Выбор сохраняется; запуск без интерактивной консоли не ждёт ввода.
- Подключение существующего бота через скрытый ввод токена BotFather либо создание через собственного менеджера проекта.
- Привязка владельца одноразовой ссылкой на пять минут. `/start` связывает аккаунт; `/play` запускает выбранное устройство.
- Зелёные запуск/продолжение, пауза, красная остановка, подтверждение остановки всех, выбор устройства, статистика, скриншот и диагностика.
- Категории уведомлений, пресеты, фильтр устройств, тихие часы, критические сообщения ночью и сводки.
- Лимиты времени/распознанных завершений матчей, тест уведомления, отключение и отвязка. RU/EN или язык панели.

## Подключение после выпуска

Запустите обновлённый xlamBOT в консоли и выберите «Подключить». Для повторной настройки:

```powershell
.\xlamBOT.exe --telegram-setup
```

Создайте бота через [BotFather](https://t.me/BotFather), введите его токен в скрытом поле консоли, затем откройте показанную ссылку и нажмите **Start**. Управление разрешено только привязанному Telegram ID и его личному чату. Не публикуйте токен и не передавайте его в переписке.

Для создания через одну кнопку владельцу проекта сначала нужно развернуть отдельный сервис менеджера с HTTPS и включить у своего бота **Bot Management Mode**. Пользователь открывает сессию своей установки, подтверждает Telegram-аккаунт и нажимает кнопку официального диалога создания. После подтверждения Telegram менеджер передаёт токен клиенту через одноразовую защищённую сессию; финальная привязка владельца остаётся обязательной. Общий секрет менеджера не распространяется в EXE. Если менеджер не настроен, работает BotFather.

Несекретный адрес менеджера задаётся через `XLAMBOT_TELEGRAM_MANAGER_URL`. Подробные команды сервиса и инструкции разработчика находятся в документации закрытого репозитория исходников. Сторонний `MTPulse_bot` не требуется.

## Настройки и ограничения

Меню: `/menu`, `/play`, `/status`, `/devices`, `/settings`, `/help`. Доступны уведомления о жизненном цикле, ошибках, ADB, известных ошибках игры, матчах, изменении кубков аккаунта, бойце, очереди и обновлениях. Пресеты: ошибки, важные события, все события, выключить.

Тихие часы по умолчанию 23:00–08:00, интервал сводки 15/30/60 минут. Для активного устройства можно выбрать остановку через 30/60/120 минут или после 5/10/20 распознанных завершений матчей. Таймер учитывает паузу; команда остановки отправляется ближайшим пятиминутным опросом — точнее, **опросом раз в пять секунд**. Если API недоступен, остановка не гарантируется до восстановления связи.

Счётчик основан на распознанных итоговых экранах текущего игрового worker, а не на официальной статистике игры. Неизвестные данные отмечаются `—`. Скриншот берётся из существующего захвата. `127.0.0.1` — локальная панель компьютера, не ссылка для телефона.

Windows хранит токен с защитой DPAPI в отдельной пользовательской папке `%LOCALAPPDATA%\xlamBOT-Telegram`; на POSIX используются права доступа к файлам. Секреты не входят в профили, диагностику или Git. Telegram работает в отдельных потоках; сбой сети не останавливает игру. Очередь уведомлений ограничена, повторяющиеся события подавляются, устаревшие сообщения удаляются. Команды не повторяются автоматически после неясного результата или перезапуска.

## Выпуск

Перед публикацией нужно объединить исходники, выполнить проверку с настоящим Telegram и эмулятором, затем собрать новую ревизию существующим `tools/publish.py` и подписать действующим ключом издателя. Только после добавления соответствующих `manifest.json`, `scripts.zip` и происхождения исходников можно завершить публичный PR.

Исходный код остаётся в закрытом репозитории. Его тесты на Python 3.13 для Windows/Linux используют заглушки Telegram; настоящий токен в CI не требуется. Автоматические проверки не заменяют приёмку на реальном аккаунте.

## English

The Telegram beta implementation is proposed in the private source PR linked above. **The current signed public build does not contain this feature yet.** Release requires merging sources, real Telegram/emulator acceptance, and publishing a new revision with the existing publisher and signing key.

After release, the console offers optional onboarding. Use `xlamBOT.exe --telegram-setup` to configure again. Connect a BotFather token through hidden input and redeem the single-use, five-minute `/start` link. `/start` pairs the owner; `/play` starts the selected device. Only the linked user and private chat can control the installation.

Managed creation requires the project's own separately hosted manager with Bot Management Mode and HTTPS. The client authenticates its Telegram owner, opens a prefilled official bot-creation dialog and claims the new token through a single-use session. Final owner pairing is required. The manager secret is never bundled. Manual BotFather onboarding remains available without a manager.

Prepared features include green start/resume, pause, red stop, confirmed stop-all, device selection, real available statistics, screenshots, diagnostics, notification categories/presets/device filters, quiet hours, critical alerts and periodic summaries. Languages are RU/EN or the panel preference. Stop limits use elapsed time or recognized completed matches; five-second monitoring needs the local API. These counters are not official game statistics. Unknown values are shown as `—`.

Windows uses per-user DPAPI storage outside xlamBOT exports; POSIX uses restricted file permissions. Networking runs independently of gameplay, with bounded queues, expiry and duplicate suppression. Ambiguous controls are not automatically replayed. A localhost panel URL does not become accessible from a phone.
