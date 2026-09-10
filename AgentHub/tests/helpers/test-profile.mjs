// Профили тестов: явное, видимое исключение вместо молчаливого удаления.
//
// Проверка, отнесённая к профилю, не удаляется и не подменяется заглушкой. Она
// остаётся в своём файле рядом с поведенческими соседями и выполняется целиком,
// когда её профиль включён. Когда профиль выключен, node:test печатает её как
// пропущенную с причиной, поэтому пропуск виден в отчёте, а не выглядит зелёным.
//
// Профиль включается переменной окружения AGENT_HUB_TEST_PROFILES: список имён
// через запятую или пробел, либо "all". Её выставляет test-suite.mjs для режимов
// cosmetic/stress/reliability; вручную это тоже работает.

const PROFILE_ENVIRONMENT_VARIABLE = "AGENT_HUB_TEST_PROFILES";

export function enabledTestProfiles(environment = process.env) {
  const raw = String(environment[PROFILE_ENVIRONMENT_VARIABLE] ?? "").trim();
  if (!raw) return new Set();
  if (raw === "all") return new Set(["all"]);
  return new Set(raw.split(/[,\s]+/u).map((name) => name.trim()).filter(Boolean));
}

export function testProfileEnabled(name, environment = process.env) {
  const enabled = enabledTestProfiles(environment);
  return enabled.has("all") || enabled.has(name);
}

// Возвращает options для node:test. Тело проверки не меняется.
export function profiled(name, options = {}, environment = process.env) {
  if (testProfileEnabled(name, environment)) return options;
  return {
    ...options,
    skip: `Профиль «${name}» выключен: запустите npm run test:${name} `
      + `или задайте ${PROFILE_ENVIRONMENT_VARIABLE}=${name}.`,
  };
}

// Полные матрицы тем, viewport и точных геометрических значений. Защищают
// оформление, а не поведение данных, и стоят заметного времени в обычном выпуске.
export const cosmeticMatrix = (options = {}) => profiled("cosmetic", options);

// Многократный перебор одного и того же взаимодействия ради устойчивости.
// Полезно при правках слоя ввода, избыточно в каждом релизе.
export const stressMatrix = (options = {}) => profiled("stress", options);

// Дорогие сценарии надёжности на настоящих процессах: конкуренция writer'ов
// SQLite, восстановление провайдера, замена runtime.
export const reliabilityScenario = (options = {}) => profiled("reliability", options);

export { PROFILE_ENVIRONMENT_VARIABLE };
