const express = require('express');
const multer = require('multer');
const fs = require('fs');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse'); // ← единственный вызов
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

// Храним текст лекции
let pdfText = "";

// Multer
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Папка фронтенда
app.use(express.static(path.join(__dirname, '../public')));

// ----------------- утилиты -----------------
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

function levenshtein(a, b) {
  a = a || '';
  b = b || '';
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

function makeFragments(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const out = [];
  for (const line of lines) {
    if (line.length > 20) out.push(line);
    const parts = line.split(/(?<=[.?!])\s+/);
    for (const p of parts) {
      const t = p.trim();
      if (t.length > 20) out.push(t);
    }
  }

  if (out.length === 0) {
    (text.match(/.{1,200}/g) || []).forEach(t => out.push(t.trim()));
  }
  return out;
}

function wordOverlapScore(a, b) {
  const A = new Set(cleanText(a).split(' ').filter(Boolean));
  const B = new Set(cleanText(b).split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let c = 0;
  for (const w of A) if (B.has(w)) c++;
  return c / Math.max(A.size, B.size);
}

function findBestFragmentForQuestion(question, fragments) {
  const qClean = cleanText(question);
  let best = { score: 0, frag: "" };
  for (const frag of fragments) {
    const fClean = cleanText(frag);
    const overlap = wordOverlapScore(qClean, fClean);
    const lev = levenshtein(qClean.slice(0,200), fClean.slice(0,200));
    const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(qClean.length, fClean.length)));

    const score = overlap * 0.7 + normLev * 0.3;
    if (score > best.score) best = { score, frag };
  }
  return best;
}

function scoreOption(option, fragments) {
  const oClean = cleanText(option);

  if (pdfText.includes(oClean) && oClean.length > 3) {
    return { score: 1.0, frag: option, exact: true };
  }

  let best = { score: 0, frag: "" };
  for (const frag of fragments) {
    const fClean = cleanText(frag);
    const overlap = wordOverlapScore(oClean, fClean);
    const lev = levenshtein(oClean.slice(0,200), fClean.slice(0,200));
    const normLev = 1 - Math.min(1, lev / Math.max(1, Math.max(oClean.length, fClean.length)));

    const score = overlap * 0.75 + normLev * 0.25;
    if (score > best.score) best = { score, frag };
  }
  return best;
}

// ----------------- Upload PDF -----------------
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const data = await fs.promises.readFile(req.file.path);
    const parsed = await pdfParse(data);
    pdfText = cleanText(parsed.text || "");

    fs.unlink(req.file.path, () => {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Parse failed' });
  }
});

// ----------------- Process Quiz HTML -----------------
app.post('/process-quiz', (req, res) => {
  const html = req.body.html;
  if (!html) return res.status(400).json({ error: 'HTML missing' });

  const $ = cheerio.load(html);
  const fragments = makeFragments(pdfText);
  const results = [];

  $('div.que').each((i, block) => {
    const question = $(block).find('.qtext').text().trim();
    const answerBlock = $(block).find('.answer').first();
    const options = [];

    answerBlock.find('p, div, label').each((i, el) => {
      const t = $(el).text().trim();
      if (t) options.push(t);
    });

    if (options.length > 0) {
      const scored = options.map(opt => {
        const r = scoreOption(opt, fragments);
        const threshold = r.exact ? 0.9 : 0.5;

        return {
          text: opt,
          score: Number(r.score.toFixed(3)),
          correct: r.score >= threshold,
          evidence: r.frag
        };
      });

      results.push({ type: 'choice', question, answers: scored });
    } else {
      const best = findBestFragmentForQuestion(question, fragments);
      results.push({
        type: 'open',
        question,
        answer: best.frag,
        confidence: Number(best.score.toFixed(3))
      });
    }
  });

  res.json({ results });
});

// ----------------- Ping -----------------
app.get('/ping', (_, res) => res.send("pong"));

// ----------------- Start -----------------
app.listen(port, () => {
  console.log("Server running on port", port);
});