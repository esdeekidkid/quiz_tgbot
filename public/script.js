// небольшой фронтенд-скрипт
const pdfForm = document.getElementById('pdfForm');
const pdfInput = document.getElementById('pdf');
const pdfStatus = document.getElementById('pdfStatus');
const processBtn = document.getElementById('processBtn');
const clearBtn = document.getElementById('clearBtn');
const htmlInput = document.getElementById('htmlInput');
const resultsWrap = document.getElementById('results');

pdfForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pdfInput.files.length) return alert('Выберите PDF файл');
  const fd = new FormData();
  fd.append('pdf', pdfInput.files[0]);
  pdfStatus.textContent = 'Загружается...';
  try {
    const r = await fetch('/upload-pdf', { method: 'POST', body: fd });
    const j = await r.json();
    if (j.ok) {
      pdfStatus.textContent = 'Лекция загружена — можно обрабатывать тесты';
    } else {
      pdfStatus.textContent = 'Ошибка: ' + (j.error || JSON.stringify(j));
    }
  } catch (err) {
    pdfStatus.textContent = 'Ошибка загрузки';
    console.error(err);
  }
});

processBtn.addEventListener('click', async () => {
  const html = htmlInput.value.trim();
  if (!html) return alert('Вставьте HTML код теста');
  resultsWrap.innerHTML = '<div class="status">Обработка...</div>';
  try {
    const r = await fetch('/process-quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html })
    });
    const j = await r.json();
    renderResults(j.results || []);
  } catch (err) {
    resultsWrap.innerHTML = '<div class="status">Ошибка при обработке</div>';
    console.error(err);
  }
});

clearBtn.addEventListener('click', () => {
  htmlInput.value = '';
  resultsWrap.innerHTML = '';
});

function renderResults(results) {
  if (!results.length) {
    resultsWrap.innerHTML = '<div class="status">В тесте не найдены вопросы.</div>';
    return;
  }
  resultsWrap.innerHTML = '';
  for (const item of results) {
    const card = document.createElement('div');
    card.className = 'qcard';
    const head = document.createElement('div');
    head.className = 'qhead';
    const qtxt = document.createElement('div');
    qtxt.className = 'qtxt';
    qtxt.textContent = item.question;
    head.appendChild(qtxt);
    card.appendChild(head);

    if (item.type === 'choice') {
      const opts = document.createElement('div');
      opts.className = 'opts';
      for (const ans of item.answers) {
        const el = document.createElement('div');
        el.className = 'opt ' + (ans.correct ? 'correct' : 'wrong');
        el.innerHTML = `<span>${escapeHtml(ans.text)}</span><small style="opacity:0.8">score: ${ans.score}</small>`;
        const ev = document.createElement('div');
        ev.className = 'evidence';
        ev.textContent = 'Найдено: ' + (ans.evidence || '—');
        el.appendChild(ev);
        opts.appendChild(el);
      }
      card.appendChild(opts);
    } else if (item.type === 'open') {
      const open = document.createElement('div');
      open.className = 'openAnswer';
      open.textContent = item.answer || 'Ответ не найден';
      const conf = document.createElement('div');
      conf.className = 'evidence';
      conf.textContent = 'Confidence: ' + (item.confidence || 0);
      card.appendChild(open);
      card.appendChild(conf);
    }
    resultsWrap.appendChild(card);
  }
  // плавный скролл к результатам
  resultsWrap.scrollIntoView({ behavior: 'smooth' });
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"'`=\/]/g, function (c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;'}[c];
  });
}