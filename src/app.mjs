// src/app.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 10000;

// --- Middleware ---
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Storage ---
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

// --- Session storage ---
const LECTURES = {};

// --- Utils ---
function normalizeText(s) {
  if (!s) return '';
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function excerptAround(text, idx, len = 120) {
  if (!text) return '';
  const start = Math.max(0, idx - Math.floor(len / 2));
  const end = Math.min(text.length, idx + Math.floor(len / 2));
  return text.substring(start, end).replace(/\s+/g, ' ');
}

function scoreOptionByLecture(lecture, option) {
  const L = normalizeText(lecture);
  const opt = normalizeText(option);

  let score = 0;

  // exact phrase occurrences
  const exactCount = (L.match(new RegExp(opt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  if (exactCount > 0) {
    score += 3 * Math.log(1 + exactCount);
  }

  // definition patterns
  if (new RegExp(opt + '\\s+(представляет собой|является|это|характеризуется|обозначает|означает)', 'i').test(lecture)) {
    score += 3;
  }

  // word overlap
  const optWords = opt.split(/\s+/).filter(Boolean);
  let matchedWords = 0;
  for (const w of optWords) {
    if (w.length < 2) continue;
    if (L.includes(' ' + w + ' ') || L.startsWith(w + ' ') || L.endsWith(' ' + w)) {
      matchedWords++;
    }
  }
  if (optWords.length > 0) {
    const ratio = matchedWords / optWords.length;
    score += ratio * 2;
  }

  return score;
}

function detectQuestionType(qtext) {
  const q = normalizeText(qtext);
  const singleMarkers = ['какое из', 'какой из', 'как называется', 'что из', 'выберите один', 'выберите', 'какое слово пропущено'];
  for (const m of singleMarkers) if (q.includes(m)) return 'single';

  const multiMarkers = ['какие', 'перечисл', 'классификация', 'входят в', 'относятся', 'какие действия', 'назовите', 'перечислите', 'признаков', 'включают'];
  for (const m of multiMarkers) if (q.includes(m)) return 'multi';

  if (q.includes('единиц') || q.includes('единицы измерения') || q.includes('единицы')) return 'units';

  if (/(какое слово пропущено|какое слово|впишите|введите|короткий ответ|ответ)/i.test(qtext)) return 'short';

  if (q.includes('что') || q.includes('определ')) return 'single';

  return 'single';
}

function parseHtmlQuiz(html) {
  const $ = cheerio.load(html);
  const questions = [];

  $('.que').each((i, el) => {
    const q = {};
    q.raw = $(el).html() || '';
    const qtext = $(el).find('.qtext').text() || $(el).find('h4').text() || $(el).text();
    q.question = qtext.replace(/\s+/g, ' ').trim();

    const opts = [];
    $(el).find('.answer').find('p').each((j, p) => {
      const t = $(p).text().replace(/\s+/g, ' ').trim();
      if (t) opts.push(t);
    });

    if (opts.length === 0) {
      $(el).find('input[type="checkbox"], input[type="radio"]').each((j, inp) => {
        const id = $(inp).attr('id');
        if (id) {
          const label = $(`label[for="${id}"]`).text().replace(/\s+/g, ' ').trim();
          if (label) opts.push(label);
        }
      });
    }

    q.options = Array.from(new Set(opts.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)));
    q.isShort = !!$(el).find('input[type="text"]').length || $(el).hasClass('shortanswer');
    questions.push(q);
  });

  if (questions.length === 0) {
    $('fieldset.ablock').each((i, f) => {
      const q = {};
      const parent = $(f).closest('.que, .content, form, body');
      q.question = parent.find('.qtext').text().replace(/\s+/g, ' ').trim() || 'Вопрос ' + (i + 1);
      const opts = [];
      $(f).find('p').each((j, p) => {
        const t = $(p).text().replace(/\s+/g, ' ').trim();
        if (t) opts.push(t);
      });
      q.options = Array.from(new Set(opts));
      q.isShort = parent.find('input[type="text"]').length > 0;
      questions.push(q);
    });
  }

  return questions;
}

// --- Routes ---

app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });

    const data = await pdfParse(req.file.buffer);
    const text = (data && data.text) ? data.text : '';
    const sessionKey = req.ip || 'default';
    LECTURES[sessionKey] = normalizeText(text);

    return res.json({
      ok: true,
      length: text.length,
      snippet: text.substring(0, 200)
    });
  } catch (err) {
    console.error('upload-pdf error', err);
    return res.status(500).json({ error: 'Ошибка разбора PDF', detail: err.message });
  }
});

app.post('/process-quiz', async (req, res) => {
  try {
    const sessionKey = req.ip || 'default';
    const lectureText = LECTURES[sessionKey] || '';
    if (!lectureText) return res.status(400).json({ error: 'Сначала загрузите PDF-лекцию (/upload-pdf).' });

    const html = req.body.html || req.body.quiz || '';
    if (!html) return res.status(400).json({ error: 'Нет HTML в теле запроса' });

    const questions = parseHtmlQuiz(html);

    const results = [];

    for (const q of questions) {
      const qtext = q.question || '';
      const type = detectQuestionType(qtext);
      const opts = q.options || [];

      if (q.isShort || type === 'short') {
        const lec = lectureText;
        const defRegex = /([А-Яа-яЁёA-Za-z0-9 \-]{2,80})\s*[—\-:]\s*это/gi;
        let m;
        let found = null;
        while ((m = defRegex.exec(lec)) !== null) {
          const cand = m[1].trim();
          if (cand.split(/\s+/).length <= 6) {
            found = { answer: cand, excerpt: excerptAround(lec, m.index) };
            break;
          }
        }

        results.push({
          question: qtext,
          type: 'short',
          answer: found ? found.answer : '',
          excerpt: found ? found.excerpt : '',
        });

        continue;
      }

      const scored = [];
      for (const opt of opts) {
        const score = scoreOptionByLecture(lectureText, opt);
        scored.push({ option: opt, score });
      }

      const maxScore = scored.reduce((m, s) => Math.max(m, s.score), 0) || 1;
      scored.forEach(s => s.norm = +(s.score / maxScore).toFixed(3));

      let selected = [];
      if (type === 'single') {
        const top = scored.slice().sort((a, b) => b.score - a.score)[0];
        if (top) selected = [{ option: top.option, score: top.norm }];
      } else if (type === 'units') {
        selected = scored.filter(s => s.norm >= 0.15).sort((a, b) => b.norm - a.norm);
      } else {
        const thresh = 0.55;
        const candidates = scored.filter(s => s.norm >= thresh);
        if (candidates.length === 0) {
          const fallback = scored.filter(s => s.norm >= 0.25);
          selected = fallback.sort((a, b) => b.norm - a.norm);
        } else {
          selected = candidates.sort((a, b) => b.norm - a.norm);
        }
      }

      results.push({
        question: qtext,
        type,
        options: scored,
        selected: selected.map(s => ({ option: s.option, score: s.norm })),
      });
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error('process-quiz error', err);
    return res.status(500).json({ error: 'Ошибка обработки', detail: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});