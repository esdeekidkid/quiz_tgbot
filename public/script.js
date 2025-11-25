// public/script.js
const pdfForm = document.getElementById('pdfForm');
const pdfFileInput = document.getElementById('pdfFile');
const pdfStatus = document.getElementById('pdfStatus');
const jsonInput = document.getElementById('jsonInput');
const evalBtn = document.getElementById('evalBtn');
const setPdfTextBtn = document.getElementById('setPdfTextBtn');
const pdfTextInput = document.getElementById('pdfTextInput');
const resultsEl = document.getElementById('results');

pdfForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = pdfFileInput.files[0];
  if (!file) { pdfStatus.textContent = 'Выберите PDF!'; return; }
  const fd = new FormData();
  fd.append('pdf', file);
  pdfStatus.textContent = 'Отправка...';
  try {
    const resp = await fetch('/upload-pdf', { method: 'POST', body: fd });
    const data = await resp.json();
    pdfStatus.textContent = data.message || JSON.stringify(data);
  } catch (err) {
    console.error(err);
    pdfStatus.textContent = 'Ошибка загрузки PDF';
  }
});

setPdfTextBtn.addEventListener('click', async () => {
  const text = pdfTextInput.value;
  if (!text) { alert('Вставьте текст лекции.'); return; }
  try {
    const r = await fetch('/set-pdf-text', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
    const j = await r.json();
    alert(j.message || 'OK');
  } catch (e) {
    console.error(e);
    alert('Ошибка');
  }
});

evalBtn.addEventListener('click', async () => {
  const raw = jsonInput.value.trim();
  if (!raw) { alert('Вставьте JSON с полями { items: [...] }'); return; }
  let items;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) items = parsed;
    else if (Array.isArray(parsed.items)) items = parsed.items;
    else if (Array.isArray(parsed.questions)) items = parsed.questions;
    else throw new Error('Неправильная структура JSON. Должны быть items: [...] или массив сверху.');
  } catch (e) {
    alert('Ошибка парсинга JSON: ' + e.message);
    return;
  }

  // POST to /evaluate
  try {
    resultsEl.innerHTML = '<div class="small">Оценка...</div>';
    const resp = await fetch('/evaluate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ items }) });
    const data = await resp.json();
    if (data.error) { resultsEl.innerHTML = `<div class="small">Ошибка: ${data.error}</div>`; return; }
    renderResults(data.results || data.results);
  } catch (e) {
    console.error(e);
    resultsEl.innerHTML = '<div class="small">Ошибка запроса</div>';
  }
});

function renderResults(results) {
  resultsEl.innerHTML = '';
  for (const item of results) {
    const wrap = document.createElement('div');
    wrap.className = 'result-card';

    const qEl = document.createElement('div');
    qEl.className = 'question';
    qEl.textContent = item.question;
    wrap.appendChild(qEl);

    if (item.type === 'choice') {
      const opts = document.createElement('div');
      opts.className = 'options';
      item.answers.forEach(a => {
        const opt = document.createElement('div');
        opt.className = 'opt ' + (a.correct ? 'correct' : 'wrong');
        opt.innerHTML = `<div>${escapeHtml(a.text)}</div><div class="badge">${a.score}</div>`;
        opts.appendChild(opt);
      });
      wrap.appendChild(opts);
    } else if (item.type === 'open') {
      const box = document.createElement('div');
      box.className = 'open-answer';
      box.innerHTML = `<div class="small">Подходящий фрагмент (score=${item.score}):</div><div>${escapeHtml(item.foundAnswer)}</div>`;
      wrap.appendChild(box);
    }

    resultsEl.appendChild(wrap);
  }
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, function(m) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]);
  });
}
