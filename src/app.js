const express = require('express');
const multer = require('multer');
const fs = require('fs');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

let pdfText = ""; // нормализованный весь текст
let rawPdfText = ""; // оригинальный извлечённый текст для evidence

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// --------- утилиты ----------
function normalize(s) {
  if (!s) return "";
  return s.toString()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d«»]/g, '"')
    .replace(/ё/g, 'е')
    .replace(/[^\wа-яё0-9\s\-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
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

function wordOverlapScore(a, b) {
  if (!a || !b) return 0;
  const A = new Set(normalize(a).split(' ').filter(Boolean));
  const B = new Set(normalize(b).split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.max(A.size, B.size);
}

// разбиваем rawPdfText на короткие фрагменты (строки/предложения) для evidence
function makeFragments(rawText) {
  if (!rawText) return [];
  const byLine = rawText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const fr = [];
  for (const ln of byLine) {
    if (ln.length > 30) fr.push(ln);
    const parts = ln.split(/(?<=[.?!])\s+/);
    for (const p of parts) {
      const t = p.trim();
      if (t.length > 30) fr.push(t);
    }
  }
  if (fr.length === 0 && rawText.length > 0) {
    (rawText.match(/.{1,200}/g) || []).forEach(x => fr.push(x.trim()));
  }
  return fr;
}

// найти в fragments лучший фрагмент, который содержит упоминание варианта (или похожее) и покрывает вопрос
function scoreOptionAgainstQuestion(option, question, fragments) {
  const oNorm = normalize(option);
  const qNorm = normalize(question);

  // 1) Если фрагмент содержит нормализованный вариант, измеряем overlap(question, fragment)
  let best = { score: 0, frag: "", exact: false };

  for (const frag of fragments) {
    const fNorm = normalize(frag);
    // проверяем, содержит ли фрагмент вариант
    // используем более гибкую проверку: либо fNorm.includes(oNorm) либо все слова варианта встречаются в фNorm
    let containsOption = false;
    if (oNorm.length > 3 && fNorm.includes(oNorm)) containsOption = true;
    else {
      const words = oNorm.split(' ').filter(Boolean);
      if (words.length > 0) {
        let all = true;
        for (const w of words) {
          if (!fNorm.includes(w)) { all = false; break; }
        }
        if (all) containsOption = true;
      }
    }
    if (!containsOption) continue;

    // если содержит вариант — насколько этот фрагмент релевантен вопросу
    const overlap = wordOverlapScore(qNorm, fNorm); // 0..1
    const lev = levenshtein(qNorm.slice(0,200), fNorm.slice(0,200));
    const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(qNorm.length, fNorm.length)));
    // комбинированный скор: сильнее учитываем overlap с вопросом
    const score = overlap * 0.75 + normLev * 0.25;

    if (score > best.score) best = { score, frag, exact: true };
  }

  // 2) Если не нашли фрагмент, ищем фрагменты похожие на вариант (по словам) — менее уверенно
  if (best.score === 0) {
    for (const frag of fragments) {
      const fNorm = normalize(frag);
      const overlapOpt = wordOverlapScore(oNorm, fNorm);
      if (overlapOpt < 0.3) continue;
      const overlapQ = wordOverlapScore(qNorm, fNorm);
      const lev = levenshtein(oNorm.slice(0,200), fNorm.slice(0,200));
      const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(oNorm.length, fNorm.length)));
      const score = overlapOpt * 0.6 + overlapQ * 0.3 + normLev * 0.1;
      if (score > best.score) best = { score, frag, exact: false };
    }
  }

  // 3) final fallback: direct substring of whole pdfText but measure overlap with question
  if (best.score === 0 && pdfText.includes(oNorm)) {
    // use small score but not zero
    const overlap = wordOverlapScore(qNorm, pdfText);
    best = { score: Math.min(0.45, overlap * 0.8 + 0.1), frag: pdfText.slice(0, 400), exact: false };
  }

  return best; // {score: 0..1, frag: "...", exact: bool}
}

// --- улучшенный поиск для открытых вопросов (пропущенное слово) ---
function findMissingWord(question, fragments) {
  // 1) Попробуем найти контекст вокруг пропуска: шаблоны "Какое слово пропущено?" и ближайшие фразы
  // Если в вопросе есть явный ввод "Какое слово пропущено?" — попытаемся найти фразу в PDF, похожую на длинную часть вопроса.
  const qNorm = normalize(question);

  // Попытаемся выделить фрагмент контекста — берем часть после "Какое слово пропущено?" или фразу вокруг "это"
  // Ищем короткую часть вопроса (20-120 символов) без метки "Какое слово..."
  let candidate = question.replace(/Какое слово пропущено|\bОтвет\b.*$/gi, '').trim();
  if (!candidate || candidate.length < 10) candidate = question;

  // пробуем сопоставить candidate с фрагментами
  let best = { score: 0, frag: "" };
  for (const frag of fragments) {
    const fNorm = normalize(frag);
    const overlap = wordOverlapScore(normalize(candidate), fNorm);
    const lev = levenshtein(normalize(candidate).slice(0,200), fNorm.slice(0,200));
    const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(candidate.length, fNorm.length)));
    const score = overlap * 0.75 + normLev * 0.25;
    if (score > best.score) best = { score, frag };
  }

  // если ничего — вернём пусто
  if (best.score < 0.25) return { answer: null, frag: '' };

  // из найденного фрагмента пытаемся извлечь пропущенное слово
  // пример в PDF: "Статическое электричество - это совокупность явлений..."
  // ищем шаблоны: "<TERM> это", "<TERM> - это", "<TERM> — это"
  const frag = best.frag;
  const m = frag.match(/([А-ЯЁа-яёA-Za-z0-9\-\s]{1,80}?)\s*(?:-|—|–|\:)?\s*это\b/i);
  if (m && m[1]) {
    const term = m[1].trim();
    // возьмём до двух слов (например "Статическое электричество")
    const words = term.split(/\s+/).filter(Boolean);
    const candidateAnswer = words.slice(0, 2).join(' ');
    return { answer: candidateAnswer, frag };
  }

  // иначе попробуем получить первый набор слов до дефиса/запятой
  const firstChunk = frag.split(/[.,;:-]/)[0].trim();
  const words = firstChunk.split(/\s+/).filter(Boolean);
  const candidateAnswer = words.slice(0, 3).join(' ');
  return { answer: candidateAnswer, frag };
}

// --------- маршруты ----------

app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const buf = await fs.promises.readFile(req.file.path);
    const parsed = await pdfParse(buf);
    rawPdfText = (parsed.text || '').replace(/\r\n/g, '\n').trim();
    pdfText = normalize(rawPdfText);
    fs.unlink(req.file.path, () => {});
    return res.json({ ok: true });
  } catch (e) {
    console.error('PDF parse error', e);
    return res.status(500).json({ error: 'Failed to parse PDF' });
  }
});

app.post('/process-quiz', (req, res) => {
  const html = req.body.html;
  if (!html) return res.status(400).json({ error: 'HTML required' });

  const $ = cheerio.load(html);
  const fragments = makeFragments(rawPdfText);
  const results = [];

  // найдем блоки вопросов (moodle .que) или fallback: .qtext parent
  const blocks = $('div.que').length ? $('div.que') : $('.qtext').parent();

  blocks.each((i, block) => {
    const qtextEl = $(block).find('.qtext').first();
    const question = (qtextEl.text() || '').trim() || `Вопрос ${i + 1}`;

    // сбор вариантов с дедупом (Set) — избавляемся от дублирования
    const optionSet = new Set();
    const options = [];

    const answerBlock = $(block).find('.answer').first();
    if (answerBlock.length) {
      // соберём текст из label, p, div, span, li
      answerBlock.find('label, p, div, span, li').each((j, el) => {
        const t = $(el).text().trim();
        if (t) {
          const cleaned = t.replace(/\s+/g, ' ').trim();
          if (!optionSet.has(cleaned)) {
            optionSet.add(cleaned);
            options.push(cleaned);
          }
        }
      });

      // fallback: разделим raw by lines
      if (options.length === 0) {
        answerBlock.text().split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(s => {
          const cleaned = s.replace(/\s+/g, ' ').trim();
          if (!optionSet.has(cleaned)) {
            optionSet.add(cleaned);
            options.push(cleaned);
          }
        });
      }
    }

    if (options.length > 0) {
      // скорим каждую опцию в контексте вопроса
      const scored = options.map(opt => {
        const r = scoreOptionAgainstQuestion(opt, question, fragments);
        // thresholds: если exact — высокая уверенность
        const threshold = r.exact ? 0.85 : 0.55;
        return {
          text: opt,
          score: Number((r.score || 0).toFixed(3)),
          evidence: r.frag || '',
          exact: !!r.exact,
          correct: (r.score || 0) >= threshold
        };
      });

      // решаем, единственный ли правильный: если max >> second_max (gap), считаем единственным
      const scores = scored.map(s => s.score);
      const sorted = [...scores].sort((a,b)=>b-a);
      const max = sorted[0]||0;
      const second = sorted[1]||0;
      const gap = max - second;

      // если есть яркий победитель (gap > 0.15 и max >= 0.6), пометить только его
      if (gap > 0.15 && max >= 0.6) {
        scored.forEach(s => s.correct = (s.score === max));
      } else {
        // иначе используем per-option threshold (уже выставлено), но не показываем evidence если score маленький
        scored.forEach(s => {
          if (s.score < 0.2) {
            s.correct = false;
            s.evidence = ''; // убираем бессмысленное evidence
          }
        });
      }

      results.push({ type: 'choice', question, answers: scored });
    } else {
      // открытый вопрос — попытка найти пропущенное слово
      const open = findMissingWord(question, fragments);
      results.push({
        type: 'open',
        question,
        answer: open.answer || 'Ответ не найден',
        evidence: open.frag || '',
        confidence: open.answer ? 0.7 : 0
      });
    }
  });

  return res.json({ results });
});

app.get('/ping', (_, res) => res.send('pong'));

app.listen(port, () => console.log('Server running on port', port));
