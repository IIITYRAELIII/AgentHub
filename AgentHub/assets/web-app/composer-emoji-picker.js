(function () {
  const groups = [
    {
      title: "Лица",
      choices: [
        ["😀", "Широкая улыбка"], ["🙂", "Улыбка"], ["😊", "Смущённая улыбка"],
        ["😂", "Смех до слёз"], ["🤣", "Хохот"], ["😉", "Подмигивание"],
        ["😍", "Влюблённый взгляд"], ["🥰", "Улыбка с сердечками"], ["😎", "В очках"],
        ["🤔", "Задумчивость"], ["🙃", "Перевёрнутый смайлик"], ["😅", "Улыбка с каплей пота"],
        ["😢", "Слеза"], ["😭", "Плач"], ["😮", "Удивление"],
        ["😬", "Гримаса"], ["🙈", "Закрытые глаза"], ["🤯", "Взрыв мозга"],
      ],
    },
    {
      title: "Жесты",
      choices: [
        ["👍", "Большой палец вверх"], ["👎", "Большой палец вниз"],
        ["👏", "Аплодисменты"], ["🙌", "Руки вверх"], ["🙏", "Сложенные ладони"],
        ["🤝", "Рукопожатие"], ["👋", "Приветствие"], ["💪", "Сила"],
        ["👌", "Окей"], ["✌️", "Победа"], ["🤞", "Скрещённые пальцы"],
        ["🫶", "Сердце руками"], ["👀", "Глаза"], ["🤷", "Пожатие плечами"],
      ],
    },
    {
      title: "Символы",
      choices: [
        ["❤️", "Красное сердце"], ["💙", "Синее сердце"], ["💚", "Зелёное сердце"],
        ["💜", "Фиолетовое сердце"], ["💔", "Разбитое сердце"], ["🔥", "Огонь"],
        ["✨", "Искры"], ["🎉", "Хлопушка"], ["✅", "Галочка"], ["❌", "Крестик"],
        ["⚠️", "Предупреждение"], ["❓", "Знак вопроса"], ["💡", "Лампочка"],
        ["🚀", "Ракета"], ["🐛", "Жук"], ["🔧", "Ключ"], ["💻", "Ноутбук"],
        ["☕", "Кофе"], ["🍿", "Попкорн"], ["🎯", "Мишень"],
      ],
    },
  ];

  function create(composer, { onOpen, onSelect }) {
    const toggle = composer.querySelector("[data-composer-emoji-toggle]");
    const picker = composer.querySelector("[data-composer-emoji-picker]");
    const categories = picker.querySelector("[data-composer-emoji-categories]");
    const grid = picker.querySelector("[data-composer-emoji-grid]");
    const closeButton = picker.querySelector("[data-composer-emoji-close]");
    const doc = composer.ownerDocument;

    function makeButton(text) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = text;
      return button;
    }

    function close() {
      picker.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }

    function dismiss() {
      if (picker.hidden) return false;
      close();
      toggle.focus({ preventScroll: true });
      return true;
    }

    function showGroup(group) {
      for (const button of categories.children) {
        button.setAttribute("aria-pressed", String(button.textContent === group.title));
      }
      grid.replaceChildren(...group.choices.map(([emoji, label]) => {
        const button = makeButton(emoji);
        button.title = label;
        button.setAttribute("aria-label", label);
        button.addEventListener("click", () => {
          close();
          onSelect(emoji);
        });
        return button;
      }));
    }

    for (const group of groups) {
      const button = makeButton(group.title);
      button.addEventListener("click", () => showGroup(group));
      categories.append(button);
    }
    showGroup(groups[0]);

    toggle.addEventListener("click", () => {
      if (!picker.hidden) {
        close();
        return;
      }
      onOpen();
      picker.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      categories.querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
    });
    closeButton.addEventListener("click", dismiss);
    composer.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || picker.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });

    function closeOutside(event) {
      if (!picker.hidden && !picker.contains(event.target) && !toggle.contains(event.target)) close();
    }
    doc.addEventListener("pointerdown", closeOutside);
    doc.addEventListener("focusin", closeOutside);

    return { close, dismiss, layer: picker };
  }

  window.AgentHubComposerEmojiPicker = { create };
})();
