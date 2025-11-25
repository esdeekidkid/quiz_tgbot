const express = require('express');
const multer = require('multer');
const fs = require('fs');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

// Храним текст последней загруженной лекции (нижний регистр)
let pdfText = "";

// Multer — сохраняем временно в uploads/
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Отдаём фронтенд из public
app.use(express.static(path.join(__dirname, '../public')));

// --------- утилиты для поиска ---------
function cleanText(s) {
  if (!s) return "";
  return s
    .toString()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d«»]/g, '"')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein distance (вес лёгкий и быстрый)
function levenshtein(a, b) {
  a = a || '';
  b = b || '';
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n];
}

// Разбиваем pdfText на "фрагменты" (строки/предложения) для поиска
function makeFragments(text) {
  const byNewline = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const fragments = [];
  for (const line of byNewline) {
    // дополнительно разбиваем по предложениям, если длинные
    const parts = line.split(/(?<=[.?!])\s+/);
    for (const p of parts) {
      const t = p.trim();
      if (t.length > 20) fragments.push(t);
    }
  }
  // если мало фрагментов, добавим более мелкие куски
  if (fragments.length === 0 && text.length > 0) {
    const fallback = text.match(/.{1,200}/g) || [];
    fallback.forEach(f => fragments.push(f.trim()));
  }
  return fragments;
}

// счётчик совпадающих слов
function wordOverlapScore(a, b) {
  if (!a || !b) return 0;
  const A = new Set(cleanText(a).split(' ').filter(Boolean));
  const B = new Set(cleanText(b).split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.max(A.size, B.size);
}

// Найти лучший фрагмент в pdfText для открытого вопроса
function findBestFragmentForQuestion(question, fragments) {
  const qClean = cleanText(question);
  const qWords = qClean.split(' ').filter(Boolean);
  let best = { score: 0, frag: "" };
  for (const frag of fragments) {
    const fClean = cleanText(frag);
    const overlap = wordOverlapScore(qClean, fClean);
    // Левенштейн на сравнительно коротких строках
    const lev = levenshtein(qClean.slice(0,200), fClean.slice(0,200));
    const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(qClean.length, fClean.length)));
    // комбинированный скор
    const score = overlap * 0.7 + normLev * 0.3;
    if (score > best.score) {
      best.score = score;
      best.frag = frag;
    }
  }
  return best;
}

// Для варианта: вернуть скор соответствия с pdf
function scoreOptionAgainstPdf(option, fragments) {
  const oClean = cleanText(option);
  let best = { score: 0, frag: "" };
  // 1) точное вхождение в pdfText
  if (pdfText.includes(oClean) && oClean.length > 3) {
    return { score: 1.0, frag: oClean, exact: true };
  }
  // 2) по фрагментам — оценим overlap и расстояние
  for (const frag of fragments) {
    const fClean = cleanText(frag);
    const overlap = wordOverlapScore(oClean, fClean);
    const lev = levenshtein(oClean.slice(0,200), fClean.slice(0,200));
    const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(oClean.length, fClean.length)));
    const score = overlap * 0.75 + normLev * 0.25;
    if (score > best.score) {
      best.score = score;
      best.frag = frag;
    }
  }
  return best;
}

// --------- Маршрут загрузки PDF ----------
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const data = await fs.promises.readFile(req.file.path);
    const parsed = await pdfParse(data);
    // чистим и сохраняем
    pdfText = cleanText(parsed.text || '');
    // удаляем временный файл
    fs.unlink(req.file.path, () => {});
    res.json({ ok: true, message: 'PDF uploaded and parsed' });
  } catch (err) {
    console.error('PDF parse error:', err);
    res.status(500).json({ error: 'Failed to parse PDF' });
  }
});

// --------- Маршрут обработки HTML теста ----------
app.post('/process-quiz', (req, res) => {
  const html = req.body.html;
  if (!html) return res.status(400).json({ error: 'HTML is required in body.html' });

  const $ = cheerio.load(html);
  const fragments = makeFragments(pdfText);
  const results = [];

  // ищем вопросы — берём контейнеры с .que (универсально для moodle)
  $('div.que').each((i, block) => {
    const qtextEl = $(block).find('.qtext').first();
    const question = qtextEl.text().trim() || `Вопрос ${i+1}`;

    // собираем варианты: ищем '.answer' внутри блока
    const optionEls = $(block).find('.answer').first();
    const options = [];
    if (optionEls.length > 0) {
      // варианты внутри .answer — парсим параграфы, divs и label'ы
      optionEls.find('p, div, label').each((j, oel) => {
        const t = $(oel).text().trim();
        if (t) options.push(t);
      });
      // если не нашли в p/div/label, попробуем прямой текст
      if (options.length === 0) {
        const raw = optionEls.text().trim();
        if (raw) {
          // попытка разделить по строкам
          raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(s => options.push(s));
        }
      }
    }

    if (options.length > 0) {
      // множественный выбор — оценим каждый вариант
      const scored = options.map(opt => {
        const sc = scoreOptionAgainstPdf(opt, fragments);
        // пометим как correct если скор >= threshold
        const threshold = sc.exact ? 0.9 : 0.5; // если exact — высокая уверенность
        return {
          text: opt,
          score: Number(sc.score.toFixed(3)),
          correct: sc.score >= threshold,
          evidence: sc.frag
        };
      });
      results.push({ type: 'choice', question, answers: scored });
    } else {
      // Открытый вопрос — находим лучший фрагмент
      const best = findBestFragmentForQuestion(question, fragments);
      results.push({ type: 'open', question, answer: best.frag, confidence: Number(best.score.toFixed(3)) });
    }
  });

  // если не нашли div.que (другая структура), сделаем fallback: найти .qtext в документе
  if (results.length === 0) {
    $('h4, p, label').each((i, el) => {
      // не делаем автозаполнение в fallback — просто возвращаем пустой результат
    });
  }

  res.json({ results });
});

// --------- Простой эндпоинт здоровья ----------
app.get('/ping', (req, res) => res.send('pong'));

// Запуск
app.listen(port, () => console.log(`Server listening on port ${port}`));

// --------- вспомогательная обёртка для pdf-parse (CommonJS require) ----------
function pdfParse(buffer) {
  // pdf-parse возвращает Promise при вызове как функция
  return pdfParseLib(buffer);
}
// require отдельно, чтобы не путать имя
const pdfParseLib = require('pdf-parse');