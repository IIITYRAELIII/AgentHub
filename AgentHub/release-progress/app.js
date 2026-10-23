const $ = id => document.getElementById(id);
const labels = { passed: 'Пройден', failed: 'Ошибка', skipped: 'Пропущен', running: 'Выполняется', pending: 'Ожидает', completed: 'Завершён' };
const duration = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} мс` : ms < 60000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.floor(ms / 60000)} мин ${Math.floor(ms % 60000 / 1000)} с`;
const state = { run: '', cases: [], tab: 'tests', limit: 100, selected: null, snapshot: null };
function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
function choose(item) {
  state.selected = item.id; $('details').hidden = false;
  $('detail-title').textContent = `${item.area} · ${labels[item.status]} · ${duration(item.durationMs)}`;
  $('detail-area').textContent = item.area; $('detail-description').textContent = item.description;
  $('detail-name').textContent = item.name; $('detail-error').textContent = item.details || (item.status === 'failed' ? 'Подробности ещё не записаны в лог.' : 'Ошибка не зафиксирована.');
}
function renderTests() {
  const query = $('search').value.toLowerCase(), filter = $('filter').value;
  const all = state.cases.filter(x => (filter === 'all' || x.status === filter) && `${x.name} ${x.area}`.toLowerCase().includes(query));
  const rows = all.slice(0, state.limit).map(item => {
    const row = node('tr', null, item.status), cell = node('td'), button = node('button', item.name, 'case-name');
    cell.append(node('span', item.area, 'case-area'), button); button.addEventListener('click', () => choose(item));
    row.append(cell, node('td', labels[item.status], 'result'), node('td', duration(item.durationMs))); return row;
  });
  $('tests').replaceChildren(...rows); $('empty').hidden = all.length > 0;
  $('shown').textContent = `Показано ${rows.length} из ${all.length}`; $('more').hidden = rows.length >= all.length;
}
function renderErrors(failures) {
  $('errors').replaceChildren(...failures.map(item => {
    const wrap = node('article', null, 'error-item'), button = node('button', item.name);
    button.addEventListener('click', () => { choose(item); $('details').scrollIntoView({ block: 'nearest' }); });
    wrap.append(button, node('p', `${item.area} · ${duration(item.durationMs)}`, 'muted'), node('pre', item.details || 'Подробности ещё не записаны в лог.')); return wrap;
  }));
  if (!failures.length) $('errors').append(node('p', 'В прочитанной части лога ошибок нет.', 'muted'));
}
function render(data) {
  state.snapshot = data;
  if (data.reset) { state.cases = []; state.limit = 100; state.selected = null; $('details').hidden = true; }
  state.run = data.run; state.cases.push(...data.cases);
  for (const failure of data.failures) state.cases[failure.id] = failure;
  document.title = data.title; $('title').textContent = data.title;
  $('fresh').textContent = `Обновлено ${new Date(data.observedAt).toLocaleTimeString('ru-RU')}`;
  $('current').textContent = data.currentStep || 'Нет текущего этапа';
  $('stage-description').textContent = data.steps.find(x => x.status === 'running')?.description || '';
  $('completed').textContent = `${data.steps.filter(x => x.status === 'completed').length} из ${data.steps.length}`;
  const terminal = ['published', 'succeeded', 'completed', 'failed', 'partial'].includes(data.status);
  $('state').textContent = terminal ? `Pipeline: ${data.status}` : 'Pipeline выполняется';
  $('elapsed').textContent = duration((data.finishedAt ? Date.parse(data.finishedAt) : Date.now()) - Date.parse(data.startedAt));
  $('last-activity').textContent = `Лог: ${new Date(data.logModifiedAt).toLocaleTimeString('ru-RU')}`;
  $('stages').replaceChildren(...data.steps.map(step => {
    const li = node('li', null, `stage ${step.status}`); li.append(node('span', null, 'dot'), node('b', step.title), node('p', step.description));
    const timing = step.startedAt ? ` · ${duration((step.finishedAt ? Date.parse(step.finishedAt) : Date.now()) - Date.parse(step.startedAt))}` : '';
    li.append(node('p', `${labels[step.status] || step.status}${timing}`));
    li.title = `${labels[step.status] || step.status}${step.startedAt ? ` · ${new Date(step.startedAt).toLocaleTimeString('ru-RU')}` : ''}${step.finishedAt ? ` → ${new Date(step.finishedAt).toLocaleTimeString('ru-RU')}` : ''}`; return li;
  }));
  $('counts').textContent = `Результатов: ${data.totalCases} · Пройдено: ${data.counts.passed} · Ошибок: ${data.counts.failed} · Пропущено: ${data.counts.skipped}`;
  $('error-count').textContent = data.counts.failed || '';
  $('last-result').textContent = data.lastResult ? `Последний завершённый тест: ${data.lastResult.name}` : 'Результаты тестов пока не записаны.';
  $('identity').textContent = `Поколение ${data.generation} · ${data.operationId}`;
  $('run-error').hidden = !data.error; $('run-error').textContent = data.error || '';
  $('log-info').textContent = `Последние ${Math.min(data.logLines, 200)} строк из ${data.logLines}. Полный файл доступен по ссылке.`;
  $('log').textContent = data.log; renderTests(); renderErrors(data.failures);
  if (state.selected != null && state.cases[state.selected]) choose(state.cases[state.selected]);
}
async function update() {
  try {
    const response = await fetch(`/api/status?after=${state.cases.length}&run=${encodeURIComponent(state.run)}`, { cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    render(data); $('connection').hidden = true;
  } catch (error) {
    $('connection').textContent = `Состояние не обновлено: ${error.message}. Последние полученные данные сохранены на экране.`;
    $('connection').hidden = false; $('fresh').textContent = 'Нет свежего ответа';
  } finally { setTimeout(update, 2000); }
}
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => {
  state.tab = button.dataset.tab;
  for (const tab of document.querySelectorAll('[data-tab]')) { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); }
  for (const name of ['tests', 'errors', 'log']) $(`${name}-panel`).hidden = name !== state.tab;
});
$('search').addEventListener('input', () => { state.limit = 100; renderTests(); });
$('filter').addEventListener('change', () => { state.limit = 100; renderTests(); });
$('more').addEventListener('click', () => { state.limit += 100; renderTests(); });
update();
