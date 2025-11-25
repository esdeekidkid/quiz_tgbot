// src/app.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Небольшая попытка использовать pdf-parse (если установлен) — иначе мы будем
// ожидать, что pdfText установлен вручную (или PDF уже распарсен вне сервера).
let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  // pdf-parse не установлен — сервер всё равно работает, но загрузка PDF не будет извлекать текст.
  console.warn('pdf-parse not installed — /upload-pdf will not extract text. Install pdf-parse if needed.');
}

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Храним текст лекции (нижний регистр)
let pdfText = "";

// multer для загрузки PDF
const upload = multer({ dest: 'uploads/' });

// ---- вспомогательные утилиты ----
const STOPWORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она',
  'так','его','но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне',
  'было','вот','от','когда','нет','для','мы','ты','они','или','его','ее'
]);

function cleanText(str) {
  if (!str) return "";
  return str
    .toString()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width
    .replace(/[«»"“”‘’']/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^a-zа-я0-9\s\-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  const s = cleanText(str);
  if (!s) return [];
  return s.split(' ').filter(w => w.length > 0 && !STOPWORDS.has(w));
}

// быстрая реализация расстояния Левенштейна (для коротких строк)
function levenshtein(a, b) {
  if (!a) a = '';
  if (!b) b = '';
  a = a.toString(); b = b.toString();
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let v0 = new Array(n + 1);
  let v1 = new Array(n + 1);
  for (let j = 0; j <= n; j++) v0[j] = j;
  for (let i = 0; i < m; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < n; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    [v0, v1] = [v1, v0];
  }
  return v0[n];
}

function normalizedLevenshteinScore(a, b) {
  if (!a || !b) return 0;
  const lev = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - (lev / maxLen); // 1.0 = identical, 0 = completely different
}

// n-gram overlap Jaccard
function jaccardNgram(aTokens, bTokens, n=1) {
  if (!aTokens.length || !bTokens.length) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const uni = new Set([...aSet, ...bSet]).size;
  return uni === 0 ? 0 : (inter / uni);
}

// комбинированный скор между вариант и текст
function scoreOptionAgainstText(option, text) {
  const optClean = cleanText(option);
  if (!optClean) return 0;
  const optTokens = tokenize(optClean);
  const textTokens = tokenize(text);

  // Metric 1: token overlap (Jaccard)
  const jaccard = jaccardNgram(optTokens, textTokens);

  // Metric 2: normalized levenshtein with a short window match
  // compute best levenshtein match between option and sliding windows of text
  const windowSize = Math.min(40, Math.max(5, optTokens.length * 3)); // words
  const textWords = cleanText(text).split(' ');
  let bestLevScore = 0;
  for (let i = 0; i < textWords.length; i++) {
    const window = textWords.slice(i, i + windowSize).join(' ');
    if (!window) break;
    const levScore = normalizedLevenshteinScore(optClean, cleanText(window));
    if (levScore > bestLevScore) bestLevScore = levScore;
    // small optimization: if perfect match found, break
    if (bestLevScore > 0.995) break;
  }

  // Metric 3: token containment (all option tokens present)
  const optSet = new Set(optTokens);
  let contained = 0;
  for (const t of optSet) if (textTokens.includes(t)) contained++;
  const containmentRatio = optSet.size ? (contained / optSet.size) : 0;

  // combine with weights (tuned for short strings)
  const combined = 0.45 * jaccard + 0.40 * bestLevScore + 0.15 * containmentRatio;
  return combined;
}

// найти лучший текстовый фрагмент для открытого вопроса
function findBestSpanForOpenQuestion(question, text) {
  const qClean = cleanText(question);
  if (!qClean) return {best: "❓ Не найдено", score: 0};
  const qTokens = tokenize(qClean);
  const words = cleanText(text).split(' ');
  const maxWindowWords = Math.min(80, Math.max(10, qTokens.length * 6));

  let best = '';
  let bestScore = 0;
  for (let i = 0; i < words.length; i++) {
    const window = words.slice(i, i + maxWindowWords).join(' ');
    if (!window) break;
    // Use combined score between question and window
    const s = scoreOptionAgainstText(qClean, window);
    if (s > bestScore) {
      bestScore = s;
      best = window;
    }
    if (bestScore > 0.99) break;
  }
  return { best: best || "❓ Не найдено", score: bestScore };
}

// ---- Routes ----

// POST /upload-pdf  - upload PDF and extract text (requires pdf-parse installed)
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  if (!pdfParse) {
    // move file, but cannot extract text
    const dest = path.join('uploads', req.file.filename + path.extname(req.file.originalname));
    fs.renameSync(req.file.path, dest);
    return res.status(200).json({ message: 'File uploaded but pdf-parse missing — cannot extract text. Install pdf-parse or set pdfText manually.' });
  }

  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(dataBuffer);
    pdfText = cleanText(data.text);
    // optionally remove uploaded file to save disk
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.json({ message: 'PDF uploaded and text extracted.', length: pdfText.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to parse PDF' });
  }
});

// POST /set-pdf-text  - set pdfText manually (useful if you already extracted)
app.post('/set-pdf-text', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  pdfText = cleanText(text);
  return res.json({ message: 'pdfText set', length: pdfText.length });
});

// POST /evaluate - принимает массив вопросов (как в твоём примере) и возвращает результаты с подсветкой
// body: { items: [ { question: "...", options: [ "...", ... ] }, ... ] }
app.post('/evaluate', (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.items)) {
    return res.status(400).json({ error: 'Send { items: [...] }' });
  }

  if (!pdfText || pdfText.length < 10) {
    console.warn('pdfText empty — evaluation will still run but likely fail to find matches.');
  }

  const results = data.items.map(item => {
    const questionRaw = item.question || '';
    const optionsRaw = Array.isArray(item.options) ? item.options : [];

    // normalize split options if the parser returned them in one string (space separated)
    let options = [];
    if (optionsRaw.length === 1 && optionsRaw[0].includes(' ')) {
      // try split by line breaks or multiples spaces
      options = optionsRaw[0].split(/\s{2,}|\n|<br>|,|;/).map(s => s.trim()).filter(Boolean);
      // if split poorly and looks like many words, fallback: try split by capitals? but keep as is
      if (options.length === 1) {
        // try splitting by single spaces only if that yields reasonable short options
        const tokens = optionsRaw[0].split(' ').map(s => s.trim()).filter(Boolean);
        if (tokens.length <= 6) options = tokens;
      }
    } else {
      options = optionsRaw.map(s => s.trim()).filter(Boolean);
    }

    // if no options -> open question
    if (options.length === 0) {
      const { best, score } = findBestSpanForOpenQuestion(questionRaw, pdfText);
      return {
        question: questionRaw,
        type: 'open',
        foundAnswer: best,
        score: Number(score.toFixed(3))
      };
    }

    // for choice questions: compute a score for each option
    const evaluated = options.map(opt => {
      const s = scoreOptionAgainstText(opt, pdfText);
      return { text: opt, score: Number(s.toFixed(3)), correct: s >= 0.55 }; // threshold (tunable)
    });

    // If none passed threshold, mark the top one(s) as candidate(s)
    const anyCorrect = evaluated.some(e => e.correct);
    if (!anyCorrect) {
      // mark top 1 (or if ties, multiple)
      const maxScore = Math.max(...evaluated.map(e => e.score));
      evaluated.forEach(e => { if (Math.abs(e.score - maxScore) < 1e-6) e.correct = true; });
    }

    return {
      question: questionRaw,
      type: 'choice',
      answers: evaluated
    };
  });

  return res.json({ results });
});

// simple GET to check status
app.get('/status', (req, res) => {
  res.json({ ok: true, pdfTextLength: pdfText.length });
});

// start
app.listen(port, () => {
  console.log(`Quiz evaluator server running on port ${port}`);
});
