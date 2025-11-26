// src/app.mjs
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as cheerio from 'cheerio';

// --- PDF ---
import * as pdfjsLib from 'pdfjs-dist';
// Установите worker для Node.js
// Используем абсолютный путь через import.meta.url
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('node_modules/pdfjs-dist/build/pdf.worker.js', import.meta.url).href;

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// Multer (в памяти, чтобы не хранить много файлов на диске)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB limit

// Хранилище одной сессии: для простоты — хранит последнюю лекцию для каждой сессии (по IP)
// (можно заменить на chat_id, если используешь бота)
const LECTURES = {}; // { sessionKey: lectureText }

// ---- UTILS ----
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

function findDefinitionInLecture(lecture, term) {
  // ищем "TERM - это", "TERM — это", "TERM это", "это TERM" и т.д.
  const L = lecture;
  const termEsc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexes = [
    new RegExp(`([А-Яа-яA-Za-z0-9\\-\\s]{1,80})[\\-—]\\s*это`, 'gi'),
    new RegExp(`(${termEsc})\\s*(?:[:\\-—])\\s*это`, 'i'),
    new RegExp(`${termEsc}\\s+представляет собой`, 'i'),
    new RegExp(`это\\s+(${termEsc})`, 'i'),
  ];

  for (const r of regexes) {
    const m = r.exec(L);
    if (m) {
      return {
        found: true,
        match: m[0],
        snippet: excerptAround(L, Math.max(0, m.index)),
      };
    }
  }
  return { found: false };
}

function scoreOptionByLecture(lecture, option) {
  // несколько признаков:
  // 1) точное вхождение опции
  // 2) все слова опции по отдельности (пересечение)
  // 3) совпадение фразы "X представляет собой" или "X - это"
  const L = normalizeText(lecture);
  const opt = normalizeText(option);

  let score = 0;
  const snippets = [];

  // exact phrase occurrences
  const exactCount = (L.match(new RegExp(opt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  if (exactCount > 0) {
    score += 3 * Math.log(1 + exactCount);
    const idx = L.indexOf(opt);
    snippets.push({ why: 'exact', excerpt: excerptAround(L, idx) });
  }

  // phrase like "opt представляет собой" or "opt - это"
  if (new RegExp(opt + '\\s+(представляет собой|является|это|характеризуется|обозначает|означает)', 'i').test(lecture)) {
    score += 3;
    const idx = L.search(new RegExp(opt + '\\s+(представляет собой|является|это|характеризуется|обозначает|означает)', 'i'));
    snippets.push({ why: 'definition', excerpt: excerptAround(L, idx) });
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
    if (ratio > 0) snippets.push({ why: 'words', matched: matchedWords + '/' + optWords.length });
  }

  // small boost for longer option that appears at least once
  if (opt.length > 30 && exactCount > 0) score += 0.5;

  return { score, snippets };
}

// Определение типа вопроса по тексту вопроса (русский)
function detectQuestionType(qtext) {
  const q = normalizeText(qtext);
  // single-choice markers
  const singleMarkers = ['какое из', 'какой из', 'как называется', 'что из', 'выберите один', 'выберите', 'какое слово пропущено'];
  for (const m of singleMarkers) if (q.includes(m)) return 'single';

  // multi-choice / classification / перечисление
  const multiMarkers = ['какие', 'перечисл', 'классификация', 'входят в', 'относятся', 'какие действия', 'назовите', 'перечислите', 'признаков', 'включают'];
  for (const m of multiMarkers) if (q.includes(m)) return 'multi';

  // units / "единицы измерения"
  if (q.includes('единиц') || q.includes('единицы измерения') || q.includes('единицы')) return 'units';

  // open short answer (input)
  if (/(какое слово пропущено|какое слово|впишите|введите|короткий ответ|ответ)/i.test(qtext)) return 'short';

  // fallback: if question length is long and contains 'что' or 'определ', treat as single
  if (q.includes('что') || q.includes('определ')) return 'single';

  // default
  return 'single';
}

// Парсер HTML теста (Moodle-like) -> возвращает [{question, options[], isShort}]
function parseHtmlQuiz(html) {
  const $ = cheerio.load(html);
  const questions = [];

  // каждая секция .que
  $('.que').each((i, el) => {
    const q = {};
    q.raw = $(el).html() || '';
    // Вопрос текст: .qtext p (или .qtext)
    const qtext = $(el).find('.qtext').text() || $(el).find('h4').text() || $(el).text();
    q.question = qtext.replace(/\s+/g, ' ').trim();

    // Опции: .answer p, .answer .r0/.r1 .flex-fill p, или input labels
    const opts = [];
    $(el).find('.answer').find('p').each((j, p) => {
      const t = $(p).text().replace(/\s+/g, ' ').trim();
      if (t) opts.push(t);
    });

    // также ищем элементы answer-label
    $(el).find('[data-region="answer-label"]').each((j, lab) => {
      const t = $(lab).text().replace(/\s+/g, ' ').trim();
      if (t) opts.push(t);
    });

    // если специальные элементы input type=text => short answer
    const isShort = !!$(el).find('input[type="text"]').length || $(el).hasClass('shortanswer');

    // fallback: try to read checkbox labels directly
    if (opts.length === 0) {
      $(el).find('input[type="checkbox"], input[type="radio"]').each((j, inp) => {
        const id = $(inp).attr('id');
        if (id) {
          const label = $(`label[for="${id}"]`).text().replace(/\s+/g, ' ').trim();
          if (label) opts.push(label);
        }
      });
    }

    // dedupe and trim options
    q.options = Array.from(new Set(opts.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)));
    q.isShort = isShort;
    questions.push(q);
  });

  // если не нашло .que - попытаться извлечь вручную: ищем все <fieldset class="ablock"> и qtext перед ними
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

// ---- ROUTES ----

// Upload PDF lecture
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });

    const arrayBuffer = req.file.buffer.buffer.slice(
      req.file.buffer.byteOffset,
      req.file.buffer.byteOffset + req.file.buffer.byteLength
    );

    const pdf = await pdfjsLib.getDocument({  arrayBuffer }).promise;
    let fullText = '';

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(s => s.str).join(' ');
      fullText += pageText + ' ';
    }

    const sessionKey = req.ip || 'default';
    LECTURES[sessionKey] = normalizeText(fullText);

    // Возвращаем длину и первый фрагмент текста для отладки
    return res.json({
      ok: true,
      length: fullText.length,
      snippet: fullText.substring(0, 200)
    });
  } catch (err) {
    console.error('upload-pdf error', err);
    return res.status(500).json({ error: 'Ошибка разбора PDF', detail: err.message });
  }
});

// Process quiz HTML
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

      // Short open-answer handling
      if (q.isShort || type === 'short') {
        // try to find definition in lecture: pattern "XXX - это ..." or "XXX — это ..."
        // also try to find phrase in lecture that continues the phrase of question
        // We'll try several heuristics
        const lec = lectureText;
        // 1) search for "— это" or "- это"
        const defRegex = /([А-Яа-яЁёA-Za-z0-9 \-]{2,80})\s*[—\-:]\s*это/gi;
        let m;
        let found = null;
        while ((m = defRegex.exec(lec)) !== null) {
          // pick the first reasonable match which isn't too long
          const cand = m[1].trim();
          if (cand.split(/\s+/).length <= 6) {
            found = { answer: cand, excerpt: excerptAround(lec, m.index) };
            break;
          }
        }

        // 2) fallback: look for pattern "Статическое электричество - это ..." (term preceding " - это")
        if (!found) {
          // try to extract noun before 'это' using small regex
          const r2 = /([А-Яа-яЁёA-Za-z0-9 \-]{2,60})\s+это\s+/gi;
          const m2 = r2.exec(lec);
          if (m2) found = { answer: m2[1].trim(), excerpt: excerptAround(lec, m2.index) };
        }

        // 3) also try to find the longest capitalized phrase followed by '-' or '—'
        if (!found) {
          const r3 = /([А-ЯЁ][А-Яа-яё'\-\s]{2,80})\s*[—\-:]\s*это/gi;
          const m3 = r3.exec(lec);
          if (m3) found = { answer: m3[1].trim(), excerpt: excerptAround(lec, m3.index) };
        }

        // 4) if none found, try to match candidate tokens from question with lecture to return best snippet
        if (!found) {
          // try to pick a short noun phrase from lecture that includes a word near "электрическ", etc.
          const qwords = normalizeText(qtext).split(/\s+/).slice(0, 6).filter(Boolean);
          let bestIdx = -1, bestLen = 0;
          for (const w of qwords) {
            const idx = lectureText.indexOf(w);
            if (idx >= 0 && w.length > bestLen) { bestIdx = idx; bestLen = w.length; }
          }
          if (bestIdx >= 0) found = { answer: lectureText.substr(bestIdx, 50).trim(), excerpt: excerptAround(lectureText, bestIdx) };
        }

        results.push({
          question: qtext,
          type: 'short',
          answer: found ? found.answer : '',
          excerpt: found ? found.excerpt : '',
        });

        continue;
      }

      // For questions with options:
      const scored = [];
      for (const opt of opts) {
        const r = scoreOptionByLecture(lectureText, opt);
        scored.push({ option: opt, score: r.score, snippets: r.snippets });
      }

      // normalize scores to [0..1]
      const maxScore = scored.reduce((m, s) => Math.max(m, s.score), 0) || 1;
      scored.forEach(s => s.norm = +(s.score / maxScore).toFixed(3));

      // decide selection policy based on type
      let selected = [];
      if (type === 'single') {
        // choose ONLY top option
        const top = scored.slice().sort((a, b) => b.score - a.score)[0];
        if (top) selected = [{ option: top.option, score: top.norm, snippets: top.snippets }];
      } else if (type === 'units') {
        // return options that have at least some match (norm > 0.1)
        selected = scored.filter(s => s.norm >= 0.15).sort((a, b) => b.norm - a.norm);
      } else {
        // multi / classification: allow multiple answers
        // pick those with norm >= 0.55 * max, or norm >= 0.25 and >0 (heuristic)
        const thresh = 0.55;
        const candidates = scored.filter(s => s.norm >= thresh);
        if (candidates.length === 0) {
          // fallback: take any with norm >= 0.25
          const fallback = scored.filter(s => s.norm >= 0.25);
          selected = fallback.sort((a, b) => b.norm - a.norm);
        } else {
          selected = candidates.sort((a, b) => b.norm - a.norm);
        }
      }

      // create "found" snippets text
      const formatted = scored.map(s => ({
        option: s.option,
        norm: s.norm,
        snippets: s.snippets,
      }));

      results.push({
        question: qtext,
        type,
        options: formatted,
        selected: selected.map(s => ({ option: s.option, score: s.norm, snippets: s.snippets })),
      });
    }

    return res.json({ ok: true, results });
  } catch (err) {
    console.error('process-quiz error', err);
    return res.status(500).json({ error: 'Ошибка обработки', detail: err.message });
  }
});

// simple index
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// start
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
